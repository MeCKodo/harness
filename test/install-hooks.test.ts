import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooksCmd } from "../src/commands/install-hooks";

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-hooks-"));
  execSync("git init -q", { cwd: dir });
  return dir;
}

test("install-hooks writes managed, executable pre-commit + pre-push", () => {
  const dir = freshRepo();
  const code = installHooksCmd(dir, false);
  assert.equal(code, 0);
  for (const name of ["pre-commit", "pre-push"]) {
    const p = join(dir, ".git", "hooks", name);
    assert.ok(existsSync(p), `${name} exists`);
    const body = readFileSync(p, "utf8");
    assert.match(body, /harness-kit-managed-hook/);
    assert.match(body, /HARNESS_KIT_CMD/);
    assert.ok((statSync(p).mode & 0o100) !== 0, `${name} is owner-executable`);
  }
});

test("install-hooks refuses to clobber a foreign hook without --force", () => {
  const dir = freshRepo();
  const p = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(p, "#!/bin/sh\necho custom-hook\n");
  const code = installHooksCmd(dir, false);
  assert.equal(code, 0);
  assert.match(readFileSync(p, "utf8"), /echo custom-hook/, "foreign hook left untouched");
});

test("install-hooks --force overwrites a foreign hook", () => {
  const dir = freshRepo();
  const p = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(p, "#!/bin/sh\necho custom-hook\n");
  const code = installHooksCmd(dir, true);
  assert.equal(code, 0);
  assert.match(readFileSync(p, "utf8"), /harness-kit-managed-hook/, "force replaced it");
});
