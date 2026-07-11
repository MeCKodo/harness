import { execSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS, readBaseline, runCapture } from "../contracts";
import { runEnforcement } from "../enforce";
import { loadManifest, validateManifest } from "../manifest";
import { renderTargets } from "../render";
import { markManualVerifyResult } from "../validation-state";
import { err, info, ok, readText, warn } from "../util";

interface VerifyOpts {
  budgetMs?: number;
  recordManualEvidence?: boolean;
}

interface CheckResult {
  ok: boolean;
  timedOut: boolean;
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

export function verifyCmd(repo: string, opts: VerifyOpts = {}): number {
  const m = loadManifest(repo);
  let failures = 0;
  const finish = (code: number): number => {
    if (opts.recordManualEvidence === false) return code;
    try {
      const marked = markManualVerifyResult(repo, code === 0);
      if (marked === "stale") warn("manual run-checks evidence no longer matches this change; rerun run-checks before relying on evidence");
      return code;
    } catch (error) {
      err(`cannot persist manual verify evidence: ${(error as Error).message}`);
      return 1;
    }
  };
  const deadline = Date.now() + Math.max(1, opts.budgetMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const remainingMs = () => deadline - Date.now();
  let budgetFailureReported = false;
  const withinBudget = (where: string): boolean => {
    if (remainingMs() > 0) return true;
    if (!budgetFailureReported) {
      failures++;
      budgetFailureReported = true;
      err(`verification budget exhausted ${where}`);
    }
    return false;
  };

  const manifestErrors = validateManifest(m).filter((issue) => issue.level === "error");
  if (manifestErrors.length) {
    info("0) Manifest validation");
    for (const issue of manifestErrors) err(issue.msg);
    info(`\nverify: FAILED (${manifestErrors.length} manifest problem(s))`);
    return finish(1);
  }

  info("1) Generated files in sync");
  for (const [rel, content] of renderTargets(m)) {
    const cur = readText(join(repo, rel));
    if (cur === null) {
      err(`${rel} missing (run \`harness-kit sync\`)`);
      failures++;
    } else if (cur !== content) {
      err(`${rel} drifted from manifest (run \`harness-kit sync\`)`);
      failures++;
    } else ok(`${rel}`);
  }

  // Things we cannot check here — collected and reported honestly at the end.
  const gaps: string[] = [];

  info("\n2) Invariants");
  for (const inv of m.invariants ?? []) {
    if (!withinBudget(`before invariant ${inv.id}`)) break;
    if (inv.manual) {
      gaps.push(`invariant ${inv.id}: manual, not machine-enforced — ${inv.rule}`);
      continue;
    }
    if (inv.enforcement) {
      const v = runEnforcement(repo, inv.id, inv.enforcement);
      if (!withinBudget(`while enforcing invariant ${inv.id}`)) break;
      if (v.length) {
        failures++;
        err(`${inv.id}: ${v.length} violation(s)`);
        for (const x of v.slice(0, 10)) info(`       ${x.file}:${x.line}  ${x.reason}  | ${x.snippet}`);
      } else ok(`${inv.id}`);
    } else if (inv.check) {
      const result = runCheck(repo, inv.check, remainingMs());
      if (result.ok) ok(`${inv.id} (check)`);
      else {
        failures++;
        err(`${inv.id}: check ${result.timedOut ? "timed out / verification budget exhausted" : "failed"} (${inv.check})`);
      }
    } else {
      gaps.push(`invariant ${inv.id}: no enforcement/check declared — ${inv.rule}`);
    }
  }

  const contracts = m.contracts ?? [];
  const autochecked = contracts.filter((c) => c.check || c.snapshot);
  if (autochecked.length) {
    info("\n3) Contracts");
    for (const c of autochecked) {
      if (!withinBudget(`before contract ${c.id}`)) break;
      if (c.check) {
        const result = runCheck(repo, c.check, remainingMs());
        if (result.ok) ok(`${c.id} (check)`);
        else {
          failures++;
          err(`${c.id}: check ${result.timedOut ? "timed out / verification budget exhausted" : "failed"} (${c.check})`);
        }
      }
      if (c.snapshot) {
        const cap = runCapture(repo, c.snapshot, remainingMs());
        if (!cap.ok) {
          failures++;
          err(`${c.id}: snapshot command ${cap.timedOut ? "timed out / verification budget exhausted" : "failed"} (${c.snapshot})`);
        } else {
          const base = readBaseline(repo, c.id);
          if (base === null) {
            warn(`${c.id}: snapshot baseline not set — run \`harness-kit accept-contract --id ${c.id}\``);
          } else if (base !== cap.stdout) {
            failures++;
            err(`${c.id}: contract drifted from baseline${c.breaking_needs ? ` (breaking -> ${c.breaking_needs})` : ""}`);
            info(`       if intended: bump version, then \`harness-kit accept-contract --id ${c.id}\``);
          } else ok(`${c.id} (snapshot)`);
        }
      }
      if (!withinBudget(`while checking contract ${c.id}`)) break;
    }
  }
  for (const c of contracts)
    if (!c.check && !c.snapshot)
      gaps.push(
        `contract ${c.id}: no automatic check` +
          (c.manual_verify ? ` — verify by hand: ${c.manual_verify}` : ""),
      );

  // Commands with side effects can't run in a plain CI gate — surface them as gaps.
  for (const [verb, c] of Object.entries(m.capabilities ?? {})) {
    if (c.mutating) gaps.push(`capability ${verb} (\`${c.run}\`): mutating — not run here, verify deliberately`);
    else if (c.background) gaps.push(`capability ${verb} (\`${c.run}\`): long-running — not run in this gate`);
  }

  info("\nGAPS — not verifiable here (report honestly, never fake)");
  if (!gaps.length) ok("no declared gaps");
  else for (const g of gaps) warn(g);

  info("");
  if (failures) {
    info(`verify: FAILED (${failures} problem(s), ${gaps.length} gap(s))`);
    return finish(1);
  }
  info(`verify: OK (${gaps.length} gap(s) — see above)`);
  return finish(0);
}
