import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooksCmd } from "../src/commands/install-hooks";
import { syncCmd } from "../src/commands/sync";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const MANIFEST = `spec: ai-harness/v0
identity:
  name: hook-fixture
  summary: lifecycle hook fixture
capabilities:
  test:
    run: 'node -e "process.exit(process.env.HK_TEST_FAIL ? 1 : 0)"'
modules:
  - name: core
    role: fixture code
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
validation:
  required_coverage: [src/**]
  policies:
    test_touch_default: advisory
`;

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message], {
    cwd: repo,
  });
}

function fixture(manifest = MANIFEST): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-hook-event-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(repo, ".agents/manifest.yaml", manifest);
  write(repo, "src/core.ts", "export const value = 1;\n");
  write(repo, "test/core.test.ts", "// initial coverage\n");
  syncCmd(repo);
  commit(repo, "initial");
  return repo;
}

function hook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "hook-event", "--repo", repo, "--agent", agent, "--event", event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function installedHook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const runner = join(repo, ".agents", "hooks", "harness-agent-hook.sh");
  const result = spawnSync("bash", [runner, agent, event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HARNESS_KIT_CMD: `${TSX} ${CLI}`, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("Claude/Codex block with decision JSON while Cursor requests a follow-up", () => {
  const repo = fixture();
  const claude = hook(repo, "claude", "stop", { session_id: "missing" });
  assert.equal(claude.status, 0);
  assert.equal(JSON.parse(claude.stdout).decision, "block");
  assert.match(JSON.parse(claude.stdout).reason, /no SessionStart baseline/);

  const codex = hook(repo, "codex", "stop", { session_id: "missing" });
  assert.equal(codex.status, 0);
  assert.equal(JSON.parse(codex.stdout).decision, "block");

  const cursor = hook(repo, "cursor", "stop", { conversation_id: "missing" });
  assert.equal(cursor.status, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /no SessionStart baseline/);
});

test("SessionStart preserves the exact base, committed changes are checked, and stop_hook_active never bypasses", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["codex"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "session-1" };
  assert.equal(installedHook(repo, "codex", "session-start", payload).status, 0);

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");
  commit(repo, "task change");

  // A resumed client session emits SessionStart again with the same id. The
  // original base must survive or the commit above would disappear.
  assert.equal(installedHook(repo, "codex", "session-start", payload).status, 0);

  const failed = installedHook(repo, "codex", "stop", { ...payload, stop_hook_active: true }, { HK_TEST_FAIL: "1" });
  assert.equal(failed.status, 0);
  assert.equal(JSON.parse(failed.stdout).decision, "block");
  assert.match(JSON.parse(failed.stdout).reason, /check test failed/);

  const passed = installedHook(repo, "codex", "stop", { ...payload, stop_hook_active: true });
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");

  const evidence = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(evidence.status, 0);
  const body = JSON.parse(evidence.stdout);
  assert.equal(body.evidence.status, "verified");
  assert.deepEqual(body.evidence.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.equal(body.evidence.verifyPassed, true);

  write(repo, "src/core.ts", "export const value = 3;\n");
  const stale = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).stale, true);
});

test("a hung verify contract is timed out early enough to return the client's blocking protocol", () => {
  const repo = fixture(`${MANIFEST}
contracts:
  - id: hung-contract
    kind: other
    desc: timeout fixture
    check: 'node -e "setTimeout(() => {}, 5000)"'
`);
  const payload = { session_id: "hung-verify" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");

  const started = Date.now();
  const stopped = hook(repo, "claude", "stop", payload, { HARNESS_KIT_VERIFY_BUDGET_MS: "75" });
  assert.ok(Date.now() - started < 3_000, "hook returns before the client-level timeout");
  assert.equal(stopped.status, 0);
  const response = JSON.parse(stopped.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /timed out|budget exhausted/);
});
