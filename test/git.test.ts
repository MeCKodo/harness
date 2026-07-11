import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectChanges, GitDiffError } from "../src/git";

function repoWithCommit(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-git-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  return repo;
}

test("collectChanges passes --base as an argument, never through a shell", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  assert.throws(
    () => collectChanges(repo, "HEAD; printf __HK_INJECTED__; #"),
    (error: unknown) => error instanceof GitDiffError && /invalid base/i.test(error.message),
  );
});

test("collectChanges distinguishes an invalid base from a clean diff", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  assert.throws(
    () => collectChanges(repo, "__missing_ref__"),
    (error: unknown) => error instanceof GitDiffError && error.kind === "invalid-base",
  );
  const clean = collectChanges(repo, "HEAD");
  assert.deepEqual(clean.files, []);
  assert.ok(clean.fingerprint);
});

test("an exact session base still sees changes after they are committed", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });

  const changes = collectChanges(repo, base, { mode: "exact" });
  assert.deepEqual(changes.files, ["src/a.ts"]);
});

test("fingerprint changes when an untracked file changes", () => {
  const repo = repoWithCommit({ "src/a.ts": "export const a = 1;\n" });
  writeFileSync(join(repo, "note.txt"), "one\n");
  const first = collectChanges(repo, "HEAD");
  writeFileSync(join(repo, "note.txt"), "two\n");
  const second = collectChanges(repo, "HEAD");
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("staged changes cannot disappear when an unstaged edit restores the base content", () => {
  const repo = repoWithCommit({ "src/a.ts": "base\n" });
  writeFileSync(join(repo, "src/a.ts"), "staged-one\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  writeFileSync(join(repo, "src/a.ts"), "base\n");
  const first = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.deepEqual(first.files, ["src/a.ts"]);
  assert.ok(first.entries.some((entry) => entry.layer === "index"));
  assert.ok(first.entries.some((entry) => entry.layer === "worktree"));

  writeFileSync(join(repo, "src/a.ts"), "staged-two\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: repo });
  writeFileSync(join(repo, "src/a.ts"), "base\n");
  const second = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.notEqual(first.fingerprint, second.fingerprint, "index content participates in the fingerprint");
});

test("fingerprints include the Git executable bit for worktree files", () => {
  const repo = repoWithCommit({ "script.sh": "#!/bin/sh\nexit 0\n" });
  execFileSync("git", ["config", "core.filemode", "true"], { cwd: repo });
  writeFileSync(join(repo, "script.sh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(repo, "script.sh"), 0o644);
  const regular = collectChanges(repo, "HEAD", { mode: "exact" });
  chmodSync(join(repo, "script.sh"), 0o755);
  const executable = collectChanges(repo, "HEAD", { mode: "exact" });
  assert.notEqual(regular.fingerprint, executable.fingerprint);
});

test("fingerprints include the current submodule commit", () => {
  const child = repoWithCommit({ "value.txt": "one\n" });
  const parent = repoWithCommit({ "README.md": "parent\n" });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child"], {
    cwd: parent,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-qam", "add child"], { cwd: parent });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent, encoding: "utf8" }).trim();
  const submodule = join(parent, "vendor", "child");
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: submodule });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: submodule });

  writeFileSync(join(submodule, "value.txt"), "two\n");
  execFileSync("git", ["add", "value.txt"], { cwd: submodule });
  execFileSync("git", ["commit", "-qm", "two"], { cwd: submodule });
  const first = collectChanges(parent, base, { mode: "exact" });

  writeFileSync(join(submodule, "value.txt"), "three\n");
  execFileSync("git", ["add", "value.txt"], { cwd: submodule });
  execFileSync("git", ["commit", "-qm", "three"], { cwd: submodule });
  const second = collectChanges(parent, base, { mode: "exact" });
  assert.notEqual(first.fingerprint, second.fingerprint);

  writeFileSync(join(submodule, "value.txt"), "dirty-four\n");
  const dirtyFour = collectChanges(parent, base, { mode: "exact" });
  writeFileSync(join(submodule, "value.txt"), "dirty-five\n");
  const dirtyFive = collectChanges(parent, base, { mode: "exact" });
  assert.notEqual(dirtyFour.fingerprint, dirtyFive.fingerprint, "dirty submodule file content participates in the fingerprint");
});
