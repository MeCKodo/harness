import { collectChanges, EMPTY_TREE_BASE } from "../git";
import { agentHookConfigurationFingerprint } from "../hook-status";
import { readLatestValidationSession, readValidationSession } from "../validation-state";
import { err, info, ok, warn } from "../util";

export interface EvidenceOpts {
  json?: boolean;
  session?: string;
}

export function evidenceCmd(repo: string, opts: EvidenceOpts = {}): number {
  let session;
  try {
    session = opts.session ? readValidationSession(repo, opts.session) : readLatestValidationSession(repo);
  } catch (error) {
    err(`cannot read validation evidence: ${(error as Error).message}`);
    return 1;
  }
  if (!session?.lastEvidence) {
    if (opts.json) process.stdout.write(JSON.stringify({ schema: "ai-harness/evidence/v1", found: false }, null, 2) + "\n");
    else warn("no validation evidence recorded for this worktree/session");
    return 1;
  }

  const body = {
    schema: "ai-harness/evidence/v1",
    found: true,
    session: session.token,
    agent: session.agent,
    createdAt: session.createdAt,
    initialDirty: session.initialDirty,
    evidence: session.lastEvidence,
  };
  const evidence = session.lastEvidence;
  let currentFingerprint = "";
  let refreshError = "";
  try {
    currentFingerprint = collectChanges(repo, evidence.resolvedBase ?? EMPTY_TREE_BASE, { mode: "exact" }).fingerprint;
  } catch (error) {
    refreshError = (error as Error).message;
  }
  const stale = !currentFingerprint || currentFingerprint !== evidence.fingerprint;
  const runChecksValid =
    (evidence.runChecksStatus !== undefined ? evidence.runChecksStatus !== "not-verified" : evidence.ok && evidence.status !== "not-verified") &&
    !stale;
  const valid = runChecksValid && evidence.verifyPassed === true;
  const hookConfigurationCurrent = session.agent !== "manual" && !!session.hookConfigFingerprint &&
    agentHookConfigurationFingerprint(repo, session.agent) === session.hookConfigFingerprint;
  const hookActive = valid && hookConfigurationCurrent;
  const result = { ...body, runChecksValid, valid, hookActive, hookConfigurationCurrent, stale, currentFingerprint, refreshError };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return valid ? 0 : 1;
  }

  if (valid) ok(evidence.status);
  else if (stale) err("stale evidence — the change no longer matches this record");
  else if (evidence.verifyPassed !== true) err("delivery evidence incomplete — matching verify result is missing or failed");
  else err(evidence.status);
  info(`session: ${session.token}`);
  info(`agent: ${session.agent}`);
  if (session.agent === "manual") warn("manual evidence does not prove that an installed lifecycle hook executed");
  info(`base: ${evidence.requestedBase} -> ${evidence.resolvedBase ?? "empty tree"}`);
  info(`fingerprint: ${evidence.fingerprint}`);
  info(`dirty at SessionStart: ${session.initialDirty.length ? session.initialDirty.join(", ") : "(none)"}`);
  if (evidence.verifyPassed !== undefined) info(`verify: ${evidence.verifyPassed ? "passed" : "failed"}`);
  else err("verify: no matching result was recorded");
  if (refreshError) err(`cannot refresh current fingerprint: ${refreshError}`);
  info(`checks: ${evidence.checks.map((check) => `${check.id}:${check.status}`).join(", ") || "(none)"}`);
  if (evidence.waivers.length) {
    info("waivers:");
    for (const waiver of evidence.waivers) warn(`${waiver.kind}:${waiver.where} — ${waiver.reason}`);
  }
  if (evidence.errors.length) {
    info("errors:");
    for (const message of evidence.errors) err(message);
  }
  return valid ? 0 : 1;
}
