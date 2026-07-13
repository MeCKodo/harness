import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTRACTS_REL = ".agents/contracts";

/** Contract ids become filenames, so keep them portable and path-separator free. */
export function isSafeContractId(id: string): boolean {
  return CONTRACT_ID_RE.test(id) && !WINDOWS_RESERVED_STEM_RE.test(id);
}

function assertSafeContractId(id: string): void {
  if (!isSafeContractId(id))
    throw new Error(`unsafe contract id "${id}": use a portable 1-128 character ASCII filename (letters, digits, dot, underscore, or hyphen; no reserved device stem)`);
}

function contractsDirectory(repo: string): string {
  return resolve(repo, CONTRACTS_REL);
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeDirectory(path: string, label: string, create: boolean): boolean {
  let stat = lstatIfExists(path);
  if (!stat) {
    if (!create) return false;
    mkdirSync(path);
    stat = lstatSync(path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink or other file`);
  return true;
}

function ensureSafeContractDirectory(repo: string, create: boolean): string | null {
  const repoRoot = resolve(repo);
  const agents = resolve(repoRoot, ".agents");
  if (!safeDirectory(agents, ".agents", create)) return null;
  const contracts = contractsDirectory(repoRoot);
  if (dirname(contracts) !== agents) throw new Error("contract storage escaped .agents");
  if (!safeDirectory(contracts, CONTRACTS_REL, create)) return null;
  return contracts;
}

/** Where an accepted contract baseline lives (commit this file). */
export function baselinePath(repo: string, id: string): string {
  assertSafeContractId(id);
  const root = contractsDirectory(repo);
  const candidate = resolve(root, `${id}.snapshot`);
  // Defense in depth: even if the id validator changes later, a baseline must
  // remain one direct child of .agents/contracts.
  if (dirname(candidate) !== root) throw new Error(`contract baseline escaped ${CONTRACTS_REL}`);
  return candidate;
}

export interface Capture {
  ok: boolean;
  stdout: string;
  error?: string;
  timedOut?: boolean;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Run a repo-provided command and capture stdout. The CLI stays protocol-agnostic:
 * it never parses the output, it only compares it against a stored baseline.
 */
export function runCapture(repo: string, cmd: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Capture {
  if (timeoutMs <= 0) return { ok: false, stdout: "", error: "verification command budget exhausted", timedOut: true };
  try {
    const stdout = execSync(cmd, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.max(1, timeoutMs),
      killSignal: "SIGTERM",
    });
    return { ok: true, stdout };
  } catch (e) {
    const error = e as Error & { code?: string };
    return { ok: false, stdout: "", error: error.message, timedOut: error.code === "ETIMEDOUT" };
  }
}

export function readBaseline(repo: string, id: string): string | null {
  const path = baselinePath(repo, id);
  if (!ensureSafeContractDirectory(repo, false)) return null;
  const stat = lstatIfExists(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${CONTRACTS_REL}/${id}.snapshot must be a regular file`);
  return readFileSync(path, "utf8");
}

export function writeBaseline(repo: string, id: string, content: string): void {
  const path = baselinePath(repo, id);
  const directory = ensureSafeContractDirectory(repo, true)!;
  const existing = lstatIfExists(path);
  if (existing) {
    const stat = existing;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${CONTRACTS_REL}/${id}.snapshot must be a regular file`);
  }

  // Write to a new sibling and rename it into place. A final-path symlink that
  // appears after preflight is replaced, never followed to an outside target.
  const temp = resolve(directory, `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  if (dirname(temp) !== directory) throw new Error(`temporary contract baseline escaped ${CONTRACTS_REL}`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The rename normally consumed the temporary path.
    }
  }
}
