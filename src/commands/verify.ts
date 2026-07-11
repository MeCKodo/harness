import { execSync } from "node:child_process";
import { DEFAULT_COMMAND_TIMEOUT_MS, readBaseline, runCapture } from "../contracts";
import { runEnforcement } from "../enforce";
import { inspectAgentHookStatus, type AgentHookStatus } from "../hook-status";
import { loadManifest, validateManifest, type Manifest } from "../manifest";
import { inspectManagedFiles } from "../managed-files";
import { renderTargets } from "../render";
import { inspectContextFreshness, type ContextFreshnessIssue } from "../state";
import { markManualVerifyResult } from "../validation-state";
import { err, info, ok, warn } from "../util";

export interface VerifyOpts {
  budgetMs?: number;
  recordManualEvidence?: boolean;
  json?: boolean;
}

interface CheckResult {
  ok: boolean;
  timedOut: boolean;
}

export interface VerifyMessage {
  level: "info" | "ok" | "warn" | "error";
  text: string;
}

export interface VerifyReport {
  schema: "ai-harness/verify-report/v1";
  ok: boolean;
  failures: number;
  manifestErrors: string[];
  context: ContextFreshnessIssue[];
  hooks: AgentHookStatus;
  gaps: string[];
  messages: VerifyMessage[];
}

function runCheck(repo: string, cmd: string, timeoutMs: number): CheckResult {
  if (timeoutMs <= 0) return { ok: false, timedOut: true };
  try {
    execSync(cmd, { cwd: repo, stdio: "ignore", timeout: Math.max(1, timeoutMs), killSignal: "SIGTERM" });
    return { ok: true, timedOut: false };
  } catch (error) {
    return { ok: false, timedOut: (error as { code?: string }).code === "ETIMEDOUT" };
  }
}

function safeInspectAgentHookStatus(repo: string): AgentHookStatus {
  try {
    return inspectAgentHookStatus(repo);
  } catch (error) {
    return {
      state: "degraded",
      configuredAgents: [],
      issues: [`cannot inspect Agent lifecycle hooks: ${(error as Error).message}`],
    };
  }
}

function verifyInternal(repo: string, opts: VerifyOpts): number {
  let manifest: Manifest;
  try {
    manifest = loadManifest(repo);
  } catch (error) {
    const message = (error as Error).message;
    const hooks = safeInspectAgentHookStatus(repo);
    try {
      if (opts.recordManualEvidence !== false) markManualVerifyResult(repo, false);
    } catch {
      // The manifest parse error remains the primary actionable failure.
    }
    if (opts.json) {
      const report: VerifyReport = {
        schema: "ai-harness/verify-report/v1",
        ok: false,
        failures: 1,
        manifestErrors: [message],
        context: [],
        hooks,
        gaps: [],
        messages: [{ level: "error", text: message }],
      };
      process.stdout.write(JSON.stringify(report) + "\n");
    } else err(message);
    return 1;
  }
  let failures = 0;
  const gaps: string[] = [];
  const context: ContextFreshnessIssue[] = [];
  const messages: VerifyMessage[] = [];
  let manifestErrors: string[] = [];
  const hooks = safeInspectAgentHookStatus(repo);

  const emit = (level: VerifyMessage["level"], text: string): void => {
    messages.push({ level, text });
    if (opts.json) return;
    if (level === "ok") ok(text);
    else if (level === "warn") warn(text);
    else if (level === "error") err(text);
    else info(text);
  };

  const finish = (requestedCode: number): number => {
    let code = requestedCode;
    if (opts.recordManualEvidence !== false) {
      try {
        const marked = markManualVerifyResult(repo, code === 0);
        if (marked === "stale") emit("warn", "manual run-checks evidence no longer matches this change; rerun run-checks before relying on evidence");
      } catch (error) {
        emit("error", `cannot persist manual verify evidence: ${(error as Error).message}`);
        failures++;
        code = 1;
      }
    }
    if (opts.json) {
      const report: VerifyReport = {
        schema: "ai-harness/verify-report/v1",
        ok: code === 0,
        failures,
        manifestErrors,
        context,
        hooks,
        gaps,
        messages,
      };
      process.stdout.write(JSON.stringify(report) + "\n");
    }
    return code;
  };

  const deadline = Date.now() + Math.max(1, opts.budgetMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const remainingMs = () => deadline - Date.now();
  let budgetFailureReported = false;
  const withinBudget = (where: string): boolean => {
    if (remainingMs() > 0) return true;
    if (!budgetFailureReported) {
      failures++;
      budgetFailureReported = true;
      emit("error", `verification budget exhausted ${where}`);
    }
    return false;
  };

  manifestErrors = validateManifest(manifest)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  if (manifestErrors.length) {
    failures += manifestErrors.length;
    emit("info", "0) Manifest validation");
    for (const message of manifestErrors) emit("error", message);
    emit("info", `\nverify: FAILED (${manifestErrors.length} manifest problem(s))`);
    return finish(1);
  }

  emit("info", "1) Generated files in sync");
  try {
    for (const inspection of inspectManagedFiles(repo, renderTargets(manifest))) {
      if (inspection.kind === "missing") {
        emit("error", `${inspection.relativePath} missing (run \`harness-kit sync\`)`);
        failures++;
      } else if (!inspection.satisfiesDesired) {
        emit("error", `${inspection.relativePath} drifted from manifest (run \`harness-kit sync\`)`);
        failures++;
      } else if (inspection.kind === "allowed-alias") emit("ok", `${inspection.relativePath} semantic alias -> AGENTS.md`);
      else emit("ok", inspection.relativePath);
    }
  } catch (error) {
    emit("error", `generated-file safety check failed: ${(error as Error).message}`);
    failures++;
  }

  emit("info", "\n2) Context freshness");
  try {
    for (const issue of inspectContextFreshness(repo, manifest)) {
      context.push(issue);
      const changed = issue.changedSources.length ? ` -> ${issue.changedSources.join(", ")}` : "";
      const message = `${issue.key}: ${issue.reason}${changed}`;
      if (issue.severity === "blocking") {
        failures++;
        emit("error", message);
      } else emit("warn", message);
    }
  } catch (error) {
    failures++;
    emit("error", `context freshness state is unreadable: ${(error as Error).message}`);
  }
  if (!context.length && !messages.some((message) => message.level === "error" && message.text.startsWith("context freshness")))
    emit("ok", "context reviews are current");

  emit("info", "\n3) Invariants");
  for (const invariant of manifest.invariants ?? []) {
    if (!withinBudget(`before invariant ${invariant.id}`)) break;
    if (invariant.manual) {
      gaps.push(`invariant ${invariant.id}: manual, not machine-enforced — ${invariant.rule}`);
      continue;
    }
    if (invariant.enforcement) {
      let violations: ReturnType<typeof runEnforcement>;
      try {
        violations = runEnforcement(repo, invariant.id, invariant.enforcement);
      } catch (error) {
        failures++;
        emit("error", `${invariant.id}: enforcement matcher/filesystem failed (${(error as Error).message})`);
        continue;
      }
      if (!withinBudget(`while enforcing invariant ${invariant.id}`)) break;
      if (violations.length) {
        failures++;
        emit("error", `${invariant.id}: ${violations.length} violation(s)`);
        for (const violation of violations.slice(0, 10))
          emit("info", `       ${violation.file}:${violation.line}  ${violation.reason}  | ${violation.snippet}`);
      } else emit("ok", invariant.id);
    } else if (invariant.check) {
      const result = runCheck(repo, invariant.check, remainingMs());
      if (result.ok) emit("ok", `${invariant.id} (check)`);
      else {
        failures++;
        emit(
          "error",
          `${invariant.id}: check ${result.timedOut ? "timed out / verification budget exhausted" : "failed"} (${invariant.check})`,
        );
      }
    } else gaps.push(`invariant ${invariant.id}: no enforcement/check declared — ${invariant.rule}`);
  }

  const contracts = manifest.contracts ?? [];
  const autochecked = contracts.filter((contract) => contract.check || contract.snapshot);
  if (autochecked.length) {
    emit("info", "\n4) Contracts");
    for (const contract of autochecked) {
      if (!withinBudget(`before contract ${contract.id}`)) break;
      try {
        if (contract.check) {
          const result = runCheck(repo, contract.check, remainingMs());
          if (result.ok) emit("ok", `${contract.id} (check)`);
          else {
            failures++;
            emit(
              "error",
              `${contract.id}: check ${result.timedOut ? "timed out / verification budget exhausted" : "failed"} (${contract.check})`,
            );
          }
        }
        if (contract.snapshot) {
          const captured = runCapture(repo, contract.snapshot, remainingMs());
          if (!captured.ok) {
            failures++;
            emit(
              "error",
              `${contract.id}: snapshot command ${captured.timedOut ? "timed out / verification budget exhausted" : "failed"} (${contract.snapshot})`,
            );
          } else {
            const baseline = readBaseline(repo, contract.id);
            if (baseline === null) emit("warn", `${contract.id}: snapshot baseline not set — run \`harness-kit accept-contract --id ${contract.id}\``);
            else if (baseline !== captured.stdout) {
              failures++;
              emit("error", `${contract.id}: contract drifted from baseline${contract.breaking_needs ? ` (breaking -> ${contract.breaking_needs})` : ""}`);
              emit("info", `       if intended: bump version, then \`harness-kit accept-contract --id ${contract.id}\``);
            } else emit("ok", `${contract.id} (snapshot)`);
          }
        }
      } catch (error) {
        failures++;
        emit("error", `${contract.id}: contract filesystem verification failed (${(error as Error).message})`);
      }
      if (!withinBudget(`while checking contract ${contract.id}`)) break;
    }
  }
  for (const contract of contracts)
    if (!contract.check && !contract.snapshot)
      gaps.push(
        `contract ${contract.id}: no automatic check` +
          (contract.manual_verify ? ` — verify by hand: ${contract.manual_verify}` : ""),
      );

  for (const [verb, capability] of Object.entries(manifest.capabilities ?? {})) {
    if (capability.mutating) gaps.push(`capability ${verb} (\`${capability.run}\`): mutating — not run here, verify deliberately`);
    else if (capability.background) gaps.push(`capability ${verb} (\`${capability.run}\`): long-running — not run in this gate`);
  }

  emit("info", "\n5) Agent lifecycle hooks");
  const configuredAgents = hooks.configuredAgents.length ? hooks.configuredAgents.join(", ") : "none";
  if (hooks.state === "active")
    emit("ok", `ACTIVE — ${hooks.evidenceAgent} produced current run-checks + verify evidence; configured: ${configuredAgents}`);
  else if (hooks.state === "configured")
    emit("warn", `CONFIGURED — ${configuredAgents}; a fresh Agent session has not produced current Stop evidence yet`);
  else emit("warn", `DEGRADED — configured: ${configuredAgents}; ${hooks.issues.join("; ")}`);

  emit("info", "\nGAPS — not verifiable here (report honestly, never fake)");
  if (!gaps.length) emit("ok", "no declared gaps");
  else for (const gap of gaps) emit("warn", gap);

  emit("info", "");
  if (failures) {
    emit("info", `verify: FAILED (${failures} problem(s), ${gaps.length} gap(s))`);
    return finish(1);
  }
  emit("info", `verify: OK (${gaps.length} gap(s) — see above)`);
  return finish(0);
}

/**
 * Keep `verify --json` a total protocol: repository-controlled matchers, paths,
 * and filesystem shapes may fail, but callers still receive exactly one report.
 */
export function verifyCmd(repo: string, opts: VerifyOpts = {}): number {
  try {
    return verifyInternal(repo, opts);
  } catch (error) {
    const message = `unexpected verification failure: ${(error as Error).message}`;
    try {
      if (opts.recordManualEvidence !== false) markManualVerifyResult(repo, false);
    } catch {
      // Preserve the primary failure and the JSON output contract.
    }
    if (opts.json) {
      const report: VerifyReport = {
        schema: "ai-harness/verify-report/v1",
        ok: false,
        failures: 1,
        manifestErrors: [],
        context: [],
        hooks: safeInspectAgentHookStatus(repo),
        gaps: [],
        messages: [{ level: "error", text: message }],
      };
      process.stdout.write(JSON.stringify(report) + "\n");
    } else err(message);
    return 1;
  }
}
