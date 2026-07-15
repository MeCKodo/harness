import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256, readText } from "./util";
import { collectChanges, EMPTY_TREE_BASE, gitAdminDir, gitRoot } from "./git";
import { loadManifest, validateManifest } from "./manifest";
import { validationPlanFingerprint, type Gap, type PlanNote } from "./planner";
import { planRepositoryChecks } from "./validation-plan";

export type HookAgent = "claude" | "cursor" | "codex" | "manual";
export type ValidationStatus =
  | "no-change"
  | "verified"
  | "verified-with-advisories"
  | "verified-with-waivers"
  | "not-verified";

export interface StoredWaiver {
  fingerprint: string;
  kind: string;
  where: string;
  reason: string;
  createdAt: string;
}

export interface CheckEvidence {
  id: string;
  status: "passed" | "failed" | "not-run";
  exitCode: number;
  durationMs: number;
}

export interface ValidationEvidence {
  schema: "ai-harness/validation-evidence/v1";
  status: ValidationStatus;
  ok: boolean;
  requestedBase: string;
  resolvedBase: string | null;
  fingerprint: string;
  profile?: string | null;
  planFingerprint?: string;
  changed: string[];
  affected: string[];
  gates?: string[];
  checks: CheckEvidence[];
  gaps: Gap[];
  notes: PlanNote[];
  waivers: StoredWaiver[];
  errors: string[];
  verifyPassed?: boolean;
  runChecksStatus?: ValidationStatus;
  createdAt: string;
}

export interface ValidationSession {
  schema: "ai-harness/validation-session/v1";
  token: string;
  agent: HookAgent;
  sessionId: string;
  repoRoot: string;
  baseSha: string | null;
  initialFingerprint: string;
  initialDirty: string[];
  /** Exact project-local runner and client config that produced this lifecycle session. */
  hookConfigFingerprint?: string;
  waivers: StoredWaiver[];
  lastEvidence?: ValidationEvidence;
  createdAt: string;
  updatedAt: string;
}

const TOKEN_RX = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stateDir(repo: string): string {
  return join(gitAdminDir(repo), "harness-kit", "validation");
}

function canonicalTarget(repo: string): string {
  try {
    return realpathSync(repo);
  } catch {
    return resolve(repo);
  }
}

function latestPath(repo: string): string {
  return join(stateDir(repo), `latest-${sha256(canonicalTarget(repo)).slice(0, 24)}.json`);
}

export function validationSessionToken(agent: HookAgent, sessionId: string): string {
  return sha256(`${agent}\0${sessionId}`);
}

function sessionPath(repo: string, token: string): string {
  if (!TOKEN_RX.test(token)) throw new Error("invalid validation session token");
  return join(stateDir(repo), `${token}.json`);
}

function readJson<T>(path: string): T | null {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function expired(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > MAX_AGE_MS;
  } catch {
    return false;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function touchLatest(repo: string, token: string): void {
  writePrivateJson(latestPath(repo), { token });
}

export function pruneValidationState(repo: string): void {
  const dir = stateDir(repo);
  let files: { path: string; mtimeMs: number }[];
  try {
    files = readdirSync(dir)
      .filter((name) => TOKEN_RX.test(name.replace(/\.json$/, "")))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  const now = Date.now();
  for (const [index, file] of files.entries()) {
    if (index >= MAX_SESSIONS || now - file.mtimeMs > MAX_AGE_MS) {
      try {
        unlinkSync(file.path);
      } catch {
        // Best-effort cleanup must never break verification.
      }
    }
  }
}

export function startValidationSession(args: {
  repo: string;
  agent: Exclude<HookAgent, "manual">;
  sessionId: string;
  baseSha: string | null;
  initialFingerprint: string;
  initialDirty: string[];
  hookConfigFingerprint?: string;
}): ValidationSession {
  const repo = gitRoot(args.repo);
  const token = validationSessionToken(args.agent, args.sessionId);
  const existing = readValidationSession(repo, token);
  if (existing) {
    const resumed = { ...existing, hookConfigFingerprint: args.hookConfigFingerprint, lastEvidence: undefined };
    writeValidationSession(repo, resumed);
    pruneValidationState(repo);
    return resumed;
  }
  const now = new Date().toISOString();
  const session: ValidationSession = {
    schema: "ai-harness/validation-session/v1",
    token,
    agent: args.agent,
    sessionId: args.sessionId,
    repoRoot: repo,
    baseSha: args.baseSha,
    initialFingerprint: args.initialFingerprint,
    initialDirty: args.initialDirty,
    ...(args.hookConfigFingerprint ? { hookConfigFingerprint: args.hookConfigFingerprint } : {}),
    waivers: [],
    createdAt: now,
    updatedAt: now,
  };
  writePrivateJson(sessionPath(repo, token), session);
  touchLatest(repo, token);
  pruneValidationState(repo);
  return session;
}

export function readValidationSession(repo: string, token: string): ValidationSession | null {
  const path = sessionPath(repo, token);
  if (expired(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Expired state is invalid even if best-effort deletion fails.
    }
    return null;
  }
  const value = readJson<ValidationSession>(path);
  return value?.schema === "ai-harness/validation-session/v1" ? value : null;
}

export function readLatestValidationSession(repo: string): ValidationSession | null {
  pruneValidationState(repo);
  const latest = readJson<{ token?: string }>(latestPath(repo));
  return latest?.token ? readValidationSession(repo, latest.token) : null;
}

/** Latest lifecycle-hook session for this repository, independent of the
 * manual latest pointer. A later manual command must not hide valid proof that
 * an installed Agent hook actually ran. */
export function readLatestHookValidationSession(repoInput: string): ValidationSession | null {
  const repo = canonicalTarget(repoInput);
  pruneValidationState(repo);
  let tokens: Array<{ token: string; mtimeMs: number }>;
  try {
    tokens = readdirSync(stateDir(repo))
      .map((name) => ({ name, token: name.replace(/\.json$/, "") }))
      .filter(({ name, token }) => name.endsWith(".json") && TOKEN_RX.test(token))
      .map(({ token }) => ({ token, mtimeMs: statSync(sessionPath(repo, token)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return null;
  }
  for (const { token } of tokens) {
    const session = readValidationSession(repo, token);
    if (session && session.agent !== "manual" && canonicalTarget(session.repoRoot) === repo) return session;
  }
  return null;
}

export function manualValidationSession(repoInput: string, baseSha: string | null, fingerprint: string): ValidationSession {
  const repo = canonicalTarget(repoInput);
  gitRoot(repo); // validate that target state has a Git admin directory
  const token = validationSessionToken("manual", repo);
  const existing = readValidationSession(repo, token);
  if (existing) return existing;
  const now = new Date().toISOString();
  const session: ValidationSession = {
    schema: "ai-harness/validation-session/v1",
    token,
    agent: "manual",
    sessionId: repo,
    repoRoot: repo,
    baseSha,
    initialFingerprint: fingerprint,
    initialDirty: [],
    waivers: [],
    createdAt: now,
    updatedAt: now,
  };
  writePrivateJson(sessionPath(repo, token), session);
  touchLatest(repo, token);
  return session;
}

export function writeValidationSession(repo: string, session: ValidationSession): void {
  const next = { ...session, updatedAt: new Date().toISOString() };
  writePrivateJson(sessionPath(repo, session.token), next);
  touchLatest(repo, session.token);
}

export function recordValidationEvidence(repo: string, session: ValidationSession, evidence: ValidationEvidence): void {
  writeValidationSession(repo, { ...session, lastEvidence: evidence });
}

export interface ValidationEvidenceFreshness {
  currentFingerprint: string;
  currentPlanFingerprint: string;
  fingerprintStale: boolean;
  planStale: boolean;
  stale: boolean;
  error: string;
}

/** Recompute both code and selected-plan identity. Evidence from older planner
 * protocols remains readable, but cannot become valid without a fresh run. */
export function inspectValidationEvidenceFreshness(repo: string, evidence: ValidationEvidence): ValidationEvidenceFreshness {
  let currentFingerprint = "";
  let currentPlanFingerprint = "";
  let error = "";
  try {
    const current = collectChanges(repo, evidence.resolvedBase ?? EMPTY_TREE_BASE, { mode: "exact" });
    currentFingerprint = current.fingerprint;
    const manifest = loadManifest(repo);
    const manifestErrors = validateManifest(manifest).filter((issue) => issue.level === "error");
    if (manifestErrors.length) throw new Error(`manifest invalid: ${manifestErrors.map((issue) => issue.msg).join("; ")}`);
    const plan = planRepositoryChecks(repo, manifest, current.entries, { profile: evidence.profile ?? undefined });
    currentPlanFingerprint = validationPlanFingerprint(plan);
  } catch (cause) {
    error = (cause as Error).message;
  }
  const fingerprintStale = !currentFingerprint || currentFingerprint !== evidence.fingerprint;
  const planStale = !currentPlanFingerprint || !evidence.planFingerprint || currentPlanFingerprint !== evidence.planFingerprint;
  if (!error && !evidence.planFingerprint) error = "validation evidence predates plan fingerprint binding; rerun run-checks";
  return { currentFingerprint, currentPlanFingerprint, fingerprintStale, planStale, stale: fingerprintStale || planStale, error };
}

export function clearValidationEvidence(repo: string, session: ValidationSession): void {
  writeValidationSession(repo, { ...session, lastEvidence: undefined });
}

export function recordWaiver(repo: string, session: ValidationSession, waiver: StoredWaiver): ValidationSession {
  const waivers = session.waivers.filter(
    (item) => !(item.fingerprint === waiver.fingerprint && item.kind === waiver.kind && item.where === waiver.where),
  );
  waivers.push(waiver);
  const next = { ...session, waivers };
  writeValidationSession(repo, next);
  return next;
}

export function markLatestVerifyResult(
  repo: string,
  token: string,
  passed: boolean,
  expectedFingerprint?: string,
  expectedPlanFingerprint?: string,
): boolean {
  const session = readValidationSession(repo, token);
  if (!session?.lastEvidence) return false;
  const evidence = session.lastEvidence;
  if (expectedFingerprint && evidence.fingerprint !== expectedFingerprint) return false;
  if (!evidence.planFingerprint || (expectedPlanFingerprint && evidence.planFingerprint !== expectedPlanFingerprint)) return false;
  const runChecksStatus = evidence.runChecksStatus ?? evidence.status;
  const runChecksOk = runChecksStatus !== "not-verified";
  recordValidationEvidence(repo, session, {
    ...evidence,
    runChecksStatus,
    verifyPassed: passed,
    status: passed ? runChecksStatus : "not-verified",
    ok: runChecksOk && passed,
  });
  return true;
}

export type ManualVerifyMark = "none" | "matched" | "stale";

/** Attach a standalone verify result only to matching manual run-checks evidence. */
export function markManualVerifyResult(repoInput: string, passed: boolean): ManualVerifyMark {
  const repo = canonicalTarget(repoInput);
  try {
    gitRoot(repo);
  } catch {
    return "none"; // verify itself remains usable in a non-Git directory
  }
  const token = validationSessionToken("manual", repo);
  const session = readValidationSession(repo, token);
  if (!session?.lastEvidence) return "none";
  const evidence = session.lastEvidence;
  const matches = !inspectValidationEvidenceFreshness(repo, evidence).stale;
  const updated = markLatestVerifyResult(repo, token, passed && matches, evidence.fingerprint, evidence.planFingerprint);
  return matches && updated ? "matched" : "stale";
}
