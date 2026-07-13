import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type ManagedFileTarget = readonly [relativePath: string, content: string];
export type ManagedFileTargetKind = "missing" | "regular" | "allowed-alias";

/**
 * Read-only facts about a generated target before a write. Callers may use
 * these facts to apply an ownership/adoption policy; this module deliberately
 * does not persist or infer ownership.
 */
export interface ManagedFileInspection {
  relativePath: string;
  absolutePath: string;
  kind: ManagedFileTargetKind;
  currentContent: string | null;
  linkTarget: string | null;
  satisfiesDesired: boolean;
}

export interface ManagedFileWriteResult {
  inspections: ManagedFileInspection[];
  written: string[];
  preservedAliases: string[];
}

export interface ManagedFileWriteOptions {
  /** Injectable so transaction-failure rollback can be tested deterministically. */
  rename?: (from: string, to: string) => void;
  /** Injectable no-replace commit for a previously missing target. */
  link?: (from: string, to: string) => void;
  /** Ownership/adoption policy evaluated on the same preflight used by the transaction. */
  authorize?: (inspections: readonly ManagedFileInspection[]) => void;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
}

interface PreflightTarget extends ManagedFileInspection {
  content: string;
  identity: FileIdentity | null;
}

interface StagedTarget {
  target: PreflightTarget;
  tempPath: string;
  backupPath: string | null;
  backupCreated: boolean;
  replacementIdentity: FileIdentity;
  installedIdentity: FileIdentity | null;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityOf(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function repositoryRoot(repo: string): string {
  let root: string;
  try {
    root = realpathSync(repo);
  } catch (error) {
    throw new Error(`cannot resolve repository root ${repo}: ${errorMessage(error)}`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`repository root is not a directory: ${repo}`);
  return root;
}

function targetPath(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("generated target path must be a non-empty string");
  }
  if (isAbsolute(relativePath)) throw new Error(`generated target path must be relative: ${relativePath}`);
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`generated target path escapes repository: ${relativePath}`);
  }
  const absolutePath = resolve(root, relativePath);
  if (absolutePath === root || !inside(root, absolutePath)) {
    throw new Error(`generated target path escapes repository: ${relativePath}`);
  }
  return absolutePath;
}

function preflightParent(root: string, parent: string, relativePath: string): void {
  let cursor = parent;
  while (true) {
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw new Error(`cannot inspect parent for ${relativePath}: ${errorMessage(error)}`);
      }
      const next = dirname(cursor);
      if (next === cursor || !inside(root, next)) {
        throw new Error(`target ${relativePath} parent escapes repository`);
      }
      cursor = next;
      continue;
    }

    let resolvedParent: string;
    try {
      resolvedParent = realpathSync(cursor);
    } catch (error) {
      throw new Error(`cannot resolve parent for ${relativePath}: ${errorMessage(error)}`);
    }
    if (!inside(root, resolvedParent)) {
      throw new Error(`target ${relativePath} parent resolves outside repository`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`target ${relativePath} parent must not be a symlink`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`target ${relativePath} parent is not a directory`);
    }
    if (!statSync(resolvedParent).isDirectory()) {
      throw new Error(`target ${relativePath} parent is not a directory`);
    }
    return;
  }
}

function ensureSafeParent(root: string, parent: string, relativePath: string): void {
  const rel = relative(root, parent);
  if (!inside(root, parent)) throw new Error(`target ${relativePath} parent escapes repository`);
  let cursor = root;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw new Error(`cannot inspect parent for ${relativePath}: ${errorMessage(error)}`);
      }
      try {
        mkdirSync(cursor);
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) {
          throw new Error(`cannot create parent for ${relativePath}: ${errorMessage(mkdirError)}`);
        }
      }
      stat = lstatSync(cursor);
    }

    let resolvedParent: string;
    try {
      resolvedParent = realpathSync(cursor);
    } catch (error) {
      throw new Error(`cannot resolve parent for ${relativePath}: ${errorMessage(error)}`);
    }
    if (!inside(root, resolvedParent)) {
      throw new Error(`target ${relativePath} parent resolves outside repository`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`target ${relativePath} parent must not be a symlink`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`target ${relativePath} parent is not a directory`);
    }
    if (!statSync(resolvedParent).isDirectory()) {
      throw new Error(`target ${relativePath} parent is not a directory`);
    }
  }
}

function openRegularNoFollow(path: string, expected: FileIdentity): { fd: number; identity: FileIdentity } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("target is no longer a regular file");
    const identity = identityOf(opened);
    if (!sameIdentity(expected, identity)) throw new Error("target changed during preflight");
    return { fd, identity };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function allowedClaudeAlias(root: string, absolutePath: string, linkTarget: string): boolean {
  if (absolutePath !== join(root, "CLAUDE.md") || isAbsolute(linkTarget)) return false;
  const normalized = normalize(linkTarget);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return false;
  return resolve(dirname(absolutePath), linkTarget) === join(root, "AGENTS.md");
}

function inspectOne(root: string, relativePath: string, content: string): PreflightTarget {
  if (typeof content !== "string") throw new Error(`generated content for ${relativePath} must be a string`);
  const absolutePath = targetPath(root, relativePath);
  preflightParent(root, dirname(absolutePath), relativePath);

  let stat: Stats;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        relativePath,
        absolutePath,
        content,
        kind: "missing",
        currentContent: null,
        linkTarget: null,
        satisfiesDesired: false,
        identity: null,
      };
    }
    throw new Error(`cannot inspect generated target ${relativePath}: ${errorMessage(error)}`);
  }

  const identity = identityOf(stat);
  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(absolutePath);
    if (!allowedClaudeAlias(root, absolutePath, linkTarget)) {
      throw new Error(`target ${relativePath} is an unsafe symlink; only CLAUDE.md -> AGENTS.md is allowed`);
    }
    return {
      relativePath,
      absolutePath,
      content,
      kind: "allowed-alias",
      currentContent: null,
      linkTarget,
      satisfiesDesired: true,
      identity,
    };
  }
  if (stat.isDirectory()) throw new Error(`target ${relativePath} is a directory`);
  if (!stat.isFile()) throw new Error(`target ${relativePath} is not a regular file`);

  const opened = openRegularNoFollow(absolutePath, identity);
  try {
    const currentContent = readFileSync(opened.fd, "utf8");
    return {
      relativePath,
      absolutePath,
      content,
      kind: "regular",
      currentContent,
      linkTarget: null,
      satisfiesDesired: currentContent === content,
      identity: opened.identity,
    };
  } finally {
    closeSync(opened.fd);
  }
}

function preflightTargets(repo: string, targets: readonly ManagedFileTarget[]): { root: string; targets: PreflightTarget[] } {
  const root = repositoryRoot(repo);
  const seen = new Set<string>();
  const inspected: PreflightTarget[] = [];
  for (const [relativePath, content] of targets) {
    const target = inspectOne(root, relativePath, content);
    if (seen.has(target.absolutePath)) throw new Error(`duplicate generated target: ${relativePath}`);
    seen.add(target.absolutePath);
    inspected.push(target);
  }
  return { root, targets: inspected };
}

function publicInspection(target: PreflightTarget): ManagedFileInspection {
  return {
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    kind: target.kind,
    currentContent: target.currentContent,
    linkTarget: target.linkTarget,
    satisfiesDesired: target.satisfiesDesired,
  };
}

export function inspectManagedFiles(repo: string, targets: readonly ManagedFileTarget[]): ManagedFileInspection[] {
  return preflightTargets(repo, targets).targets.map(publicInspection);
}

function siblingArtifact(path: string, role: "tmp" | "backup"): string {
  return join(dirname(path), `.${basename(path)}.harness-kit-${process.pid}-${randomUUID()}.${role}`);
}

function writeExclusive(path: string, content: string | Buffer, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode & 0o777,
  );
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function unchanged(previous: PreflightTarget, current: PreflightTarget): boolean {
  if (previous.absolutePath !== current.absolutePath || previous.kind !== current.kind) return false;
  if (!sameIdentity(previous.identity, current.identity)) return false;
  if (previous.kind === "regular") return previous.currentContent === current.currentContent;
  if (previous.kind === "allowed-alias") return previous.linkTarget === current.linkTarget;
  return true;
}

function assertPreflightStillCurrent(root: string, targets: readonly PreflightTarget[]): void {
  for (const target of targets) {
    assertTargetStillCurrent(root, target);
  }
}

function assertTargetStillCurrent(root: string, target: PreflightTarget): void {
  const current = inspectOne(root, target.relativePath, target.content);
  if (!unchanged(target, current)) throw new Error(`generated target changed after preflight: ${target.relativePath}`);
}

function removeBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      // Cleanup is best effort; the primary transaction error is more useful.
    }
  }
}

function currentIdentity(path: string): FileIdentity | null {
  try {
    return identityOf(lstatSync(path));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function restoreDisplacedRegular(item: StagedTarget): void {
  if (item.backupPath === null || !item.backupCreated) throw new Error("regular target has no rollback backup");
  const current = currentIdentity(item.target.absolutePath);
  if (current !== null) {
    if (item.installedIdentity === null || !sameIdentity(item.installedIdentity, current))
      throw new Error("target changed during transaction; preserving the newer path and rollback backup");
    unlinkSync(item.target.absolutePath);
  }
  // A hard link is an atomic no-replace restore. If another process creates
  // the path during the brief restore window, EEXIST preserves both its file
  // and our displaced original backup for manual recovery.
  linkSync(item.backupPath, item.target.absolutePath);
  unlinkSync(item.backupPath);
  item.backupCreated = false;
  item.installedIdentity = null;
}

function rollback(staged: readonly StagedTarget[]): string[] {
  const errors: string[] = [];
  for (const item of [...staged].reverse()) {
    if (item.target.kind === "regular" && item.backupCreated) {
      try {
        restoreDisplacedRegular(item);
      } catch (error) {
        const retained = item.backupPath === null ? "" : ` (backup retained at ${item.backupPath})`;
        errors.push(`${item.target.relativePath}: ${errorMessage(error)}${retained}`);
      }
      continue;
    }
    if (item.installedIdentity === null) continue;
    try {
      const current = currentIdentity(item.target.absolutePath);
      if (!sameIdentity(item.installedIdentity, current))
        throw new Error("target changed after transaction write; preserving the newer path and rollback backup");
      if (item.target.kind === "missing") {
        try {
          unlinkSync(item.target.absolutePath);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    } catch (error) {
      const retained = item.backupPath === null ? "" : ` (backup retained at ${item.backupPath})`;
      errors.push(`${item.target.relativePath}: ${errorMessage(error)}${retained}`);
    }
  }
  return errors;
}

function cleanup(staged: readonly StagedTarget[], preserveBackups = false): void {
  for (const item of staged) {
    removeBestEffort(item.tempPath);
    if (!preserveBackups && item.backupPath !== null && item.backupCreated) {
      removeBestEffort(item.backupPath);
      item.backupCreated = false;
    }
  }
}

function assertInstalledTargetsStillCurrent(staged: readonly StagedTarget[]): void {
  for (const item of staged) {
    if (item.installedIdentity === null) continue;
    const current = currentIdentity(item.target.absolutePath);
    if (!sameIdentity(item.installedIdentity, current))
      throw new Error(`generated target changed during transaction: ${item.target.relativePath}`);
    const opened = openRegularNoFollow(item.target.absolutePath, item.installedIdentity);
    try {
      if (readFileSync(opened.fd, "utf8") !== item.target.content)
        throw new Error(`generated target content changed during transaction: ${item.target.relativePath}`);
    } finally {
      closeSync(opened.fd);
    }
  }
}

export function writeManagedFiles(
  repo: string,
  targets: readonly ManagedFileTarget[],
  options: ManagedFileWriteOptions = {},
): ManagedFileWriteResult {
  const preflight = preflightTargets(repo, targets);
  options.authorize?.(preflight.targets.map(publicInspection));
  const writable = preflight.targets.filter(
    (target) => target.kind !== "allowed-alias" && !target.satisfiesDesired,
  );
  const staged: StagedTarget[] = [];
  const rename = options.rename ?? renameSync;
  const link = options.link ?? linkSync;

  try {
    for (const target of writable) {
      ensureSafeParent(preflight.root, dirname(target.absolutePath), target.relativePath);
      const tempPath = siblingArtifact(target.absolutePath, "tmp");
      const backupPath = target.kind === "regular" ? siblingArtifact(target.absolutePath, "backup") : null;
      const mode = target.identity?.mode ?? 0o666;
      writeExclusive(tempPath, target.content, mode);
      if (target.identity !== null) chmodSync(tempPath, target.identity.mode & 0o777);
      const item: StagedTarget = {
        target,
        tempPath,
        backupPath,
        backupCreated: false,
        replacementIdentity: identityOf(lstatSync(tempPath)),
        installedIdentity: null,
      };
      staged.push(item);
    }

    assertPreflightStillCurrent(preflight.root, preflight.targets);

    for (const item of staged) {
      assertTargetStillCurrent(preflight.root, item.target);
      if (item.target.kind === "missing") {
        // Hard-linking a sibling temp file gives missing targets atomic
        // no-replace semantics. A file that appears after preflight causes
        // EEXIST instead of being overwritten or later deleted by rollback.
        link(item.tempPath, item.target.absolutePath);
        item.installedIdentity = item.replacementIdentity;
        unlinkSync(item.tempPath);
      } else {
        if (item.backupPath === null || item.target.identity === null)
          throw new Error(`regular target has no displacement backup: ${item.target.relativePath}`);
        // Move the live inode out of the way, then validate what was moved.
        // This prevents a last-moment update from being silently replaced.
        rename(item.target.absolutePath, item.backupPath);
        item.backupCreated = true;
        const displacedIdentity = identityOf(lstatSync(item.backupPath));
        const displacedContent = readFileSync(item.backupPath, "utf8");
        if (!sameIdentity(item.target.identity, displacedIdentity) || displacedContent !== item.target.currentContent)
          throw new Error(`generated target changed during commit: ${item.target.relativePath}`);
        link(item.tempPath, item.target.absolutePath);
        item.installedIdentity = item.replacementIdentity;
        unlinkSync(item.tempPath);
      }
    }
    assertInstalledTargetsStillCurrent(staged);
  } catch (error) {
    const rollbackErrors = rollback(staged);
    cleanup(staged, rollbackErrors.length > 0);
    const suffix = rollbackErrors.length ? `; rollback failed for ${rollbackErrors.join(", ")}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  }

  cleanup(staged);
  return {
    inspections: preflight.targets.map(publicInspection),
    written: writable.map((target) => target.relativePath),
    preservedAliases: preflight.targets
      .filter((target) => target.kind === "allowed-alias")
      .map((target) => target.relativePath),
  };
}
