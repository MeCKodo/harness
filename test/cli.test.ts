import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

test("run-checks exposes scoped waiver and evidence options", () => {
  const result = spawnSync(TSX, [CLI, "run-checks", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--where <scope>/);
  assert.match(result.stdout, /--session <token>/);
});

test("install-hooks rejects unknown agent names instead of silently writing a config", () => {
  const result = spawnSync(TSX, [CLI, "install-hooks", "--stop", "--agents", "claude,unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid --agents value/);
});

test("the real CLI blocks an implicit manual no-change result", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-no-change-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "manifest.yaml"), "spec: v\nidentity: { name: fixture, summary: fixture }\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", "initial"], {
    cwd: repo,
  });

  const result = spawnSync(TSX, [CLI, "run-checks", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).gaps.some((gap: { kind: string }) => gap.kind === "manual-base-required"));
});
