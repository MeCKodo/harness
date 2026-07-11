import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

export type GitDiffErrorKind = "not-a-repo" | "invalid-base" | "diff-failed";

export class GitDiffError extends Error {
  constructor(
    public readonly kind: GitDiffErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GitDiffError";
  }
}

export interface ChangeEntry {
  path: string;
  status: string;
  layer: "index" | "worktree" | "untracked";
}

export interface ChangeSet {
  requestedBase: string;
  resolvedBase: string | null;
  head: string | null;
  files: string[];
  entries: ChangeEntry[];
  fingerprint: string;
}

export interface CollectChangesOptions {
  /** Branch/PR bases use merge-base; SessionStart snapshots use exact. */
  mode?: "merge-base" | "exact";
}

export const EMPTY_TREE_BASE = "(empty-tree)";

function errorText(error: unknown): string {
  const e = error as { stderr?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : e.stderr;
  return String(stderr || e.message || error).trim();
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new GitDiffError("diff-failed", `git ${args[0] ?? "command"} failed: ${errorText(error)}`);
  }
}

function tryCommit(repo: string, ref: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitRoot(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new GitDiffError("not-a-repo", `not a git repo: ${errorText(error)}`);
  }
}

export function gitAdminDir(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new GitDiffError("not-a-repo", `cannot resolve git metadata dir: ${errorText(error)}`);
  }
}

function parseNameStatus(raw: string, layer: ChangeEntry["layer"]): ChangeEntry[] {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: ChangeEntry[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++] ?? "";
    const code = status[0] ?? "M";
    const first = fields[i++];
    if (first === undefined) throw new GitDiffError("diff-failed", "git diff returned malformed name-status output");
    if (code === "R") {
      const second = fields[i++];
      if (second === undefined) throw new GitDiffError("diff-failed", "git diff returned malformed rename output");
      entries.push({ path: first, status: "D", layer }, { path: second, status: "A", layer });
    } else if (code === "C") {
      const second = fields[i++];
      if (second === undefined) throw new GitDiffError("diff-failed", "git diff returned malformed copy output");
      entries.push({ path: second, status: "A", layer });
    } else {
      entries.push({ path: first, status: code, layer });
    }
  }
  return entries;
}

function nulList(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

function targetPrefix(root: string, target: string): string {
  const native = relative(root, target);
  if (!native) return "";
  if (isAbsolute(native) || native === ".." || native.startsWith(`..${sep}`))
    throw new GitDiffError("not-a-repo", `target is outside its Git worktree: ${target}`);
  return native.split(sep).join("/");
}

function scopeEntries(entries: ChangeEntry[], prefix: string): ChangeEntry[] {
  if (!prefix) return entries;
  const start = `${prefix}/`;
  return entries
    .filter((entry) => entry.path.startsWith(start))
    .map((entry) => ({ ...entry, path: entry.path.slice(start.length) }));
}

function digestPath(repo: string, rel: string): string {
  const abs = join(repo, rel);
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    if (stat.isDirectory()) {
      try {
        const head = execFileSync("git", ["-C", abs, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const nested = collectChanges(abs, "HEAD", { mode: "exact" });
        return `gitlink:${head}:${nested.fingerprint}`;
      } catch {
        return `directory:${stat.mode}`;
      }
    }
    if (!stat.isFile()) return `other:${stat.mode}`;
    const gitMode = stat.mode & 0o111 ? "100755" : "100644";
    return `file:${gitMode}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
  } catch {
    return "(missing)";
  }
}

function digestIndex(repo: string, rel: string): string {
  try {
    const entry = execFileSync("git", ["ls-files", "--stage", "-z", "--", rel], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return entry || "(missing-index)";
  } catch (error) {
    throw new GitDiffError("diff-failed", `cannot fingerprint Git index entry ${rel}: ${errorText(error)}`);
  }
}

function fingerprint(repo: string, resolvedBase: string | null, entries: ChangeEntry[]): string {
  const hash = createHash("sha256");
  hash.update("harness-kit/change-fingerprint/v1\0");
  hash.update(resolvedBase ?? EMPTY_TREE_BASE);
  for (const entry of entries) {
    hash.update("\0");
    hash.update(entry.layer);
    hash.update("\0");
    hash.update(entry.status);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.layer === "index" ? digestIndex(repo, entry.path) : digestPath(repo, entry.path));
  }
  return hash.digest("hex");
}

/**
 * Collect the complete current change relative to a base: committed, staged,
 * unstaged, and untracked. Git is always invoked with an argument array, never
 * through a shell. Operational failures throw GitDiffError and must fail closed.
 */
export function collectChanges(repoInput: string, base = "HEAD", opts: CollectChangesOptions = {}): ChangeSet {
  const target = canonicalPath(repoInput);
  const root = canonicalPath(gitRoot(target));
  const prefix = targetPrefix(root, target);
  const head = tryCommit(root, "HEAD");
  let baseCommit: string | null;

  if (base === EMPTY_TREE_BASE) {
    baseCommit = null;
  } else {
    baseCommit = tryCommit(root, base);
    if (!baseCommit && base === "HEAD" && !head) baseCommit = null;
    else if (!baseCommit) throw new GitDiffError("invalid-base", `invalid base ref: ${base}`);
  }

  let resolvedBase = baseCommit;
  if ((opts.mode ?? "merge-base") === "merge-base" && baseCommit && head) {
    try {
      resolvedBase = git(root, ["merge-base", baseCommit, head]).trim();
    } catch (error) {
      throw new GitDiffError("invalid-base", `invalid base ref or no merge base: ${base} (${(error as Error).message})`);
    }
  }

  let entries: ChangeEntry[];
  if (resolvedBase) {
    entries = parseNameStatus(git(root, ["diff", "--cached", "--name-status", "-z", resolvedBase, "--"]), "index");
  } else {
    entries = nulList(git(root, ["ls-files", "--cached", "-z"])).map((path) => ({ path, status: "A", layer: "index" }));
  }

  entries.push(...parseNameStatus(git(root, ["diff", "--name-status", "-z", "--"]), "worktree"));

  for (const path of nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    entries.push({ path, status: "A", layer: "untracked" });
  }

  entries = scopeEntries(entries, prefix);
  entries = entries.sort((a, b) => a.path.localeCompare(b.path) || a.layer.localeCompare(b.layer) || a.status.localeCompare(b.status));
  const files = [...new Set(entries.map((entry) => entry.path))];
  return {
    requestedBase: base,
    resolvedBase,
    head,
    files,
    entries,
    fingerprint: fingerprint(target, resolvedBase, entries),
  };
}

/** Compatibility helper for callers that only need paths. */
export function changedFiles(repo: string, base = "HEAD"): string[] {
  return collectChanges(repo, base).files;
}
