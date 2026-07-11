import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooksCmd } from "../src/commands/install-hooks";

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-hooks-"));
  execSync("git init -q", { cwd: dir });
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", "manifest.yaml"), "spec: v\nidentity: { name: test }\n");
  return dir;
}

test("install-hooks writes managed, executable pre-commit + pre-push", () => {
  const dir = freshRepo();
  const code = installHooksCmd(dir, { git: true });
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
  const code = installHooksCmd(dir, { git: true });
  assert.equal(code, 0);
  assert.match(readFileSync(p, "utf8"), /echo custom-hook/, "foreign hook left untouched");
});

test("install-hooks --force overwrites a foreign hook", () => {
  const dir = freshRepo();
  const p = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(p, "#!/bin/sh\necho custom-hook\n");
  const code = installHooksCmd(dir, { git: true, force: true });
  assert.equal(code, 0);
  assert.match(readFileSync(p, "utf8"), /harness-kit-managed-hook/, "force replaced it");
});

test("install-hooks --stop writes a pinned shared runner + SessionStart/Stop hooks per agent tool", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true }), 0);

  const script = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  assert.ok(existsSync(script), "shared runner exists");
  const runner = readFileSync(script, "utf8");
  assert.match(runner, /hook-event/);
  assert.match(runner, /@erzhe\/harness-kit@\d+\.\d+\.\d+/);
  assert.ok((statSync(script).mode & 0o100) !== 0, "runner is executable");

  const claude = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(claude.hooks.Stop[0].hooks[0].command, /harness-agent-hook\.sh.*stop/);
  const cursor = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
  assert.match(cursor.hooks.sessionStart[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(cursor.hooks.stop[0].command, /harness-agent-hook\.sh.*stop/);
  const codex = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  assert.match(codex.hooks.SessionStart[0].hooks[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(codex.hooks.Stop[0].hooks[0].command, /harness-agent-hook\.sh.*stop/);
  assert.match(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), /\[features\][\s\S]*hooks = true/);
});

test("install-hooks --stop merges into existing config and stays idempotent", () => {
  const dir = freshRepo();
  const p = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(p, JSON.stringify({ permissions: { allow: ["Read"] } }));

  installHooksCmd(dir, { stop: true, agents: ["claude"] });
  const once = JSON.parse(readFileSync(p, "utf8"));
  once.hooks.Stop[0].hooks.push({ type: "command", command: "echo custom-sibling" });
  writeFileSync(p, JSON.stringify(once));
  installHooksCmd(dir, { stop: true, agents: ["claude"] }); // second run must not duplicate or delete siblings

  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(cfg.permissions.allow, ["Read"], "existing keys preserved");
  const ours = cfg.hooks.Stop.filter((g: any) => g.hooks?.some((h: any) => /harness-agent-hook\.sh/.test(h.command)));
  assert.equal(ours.length, 1, "our Stop hook present exactly once");
  assert.ok(cfg.hooks.Stop.some((g: any) => g.hooks?.some((h: any) => h.command === "echo custom-sibling")));
  assert.equal(cfg.hooks.SessionStart.length, 1, "our SessionStart hook present exactly once");
});

test("install-hooks --stop fails closed on invalid JSON", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{broken");
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude"] }), 1);
});

test("Codex feature enablement preserves existing project TOML and is idempotent", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const path = join(dir, ".codex", "config.toml");
  writeFileSync(path, 'model = "gpt-5"\n\n[features]\nmemories = true\ncodex_hooks = false\nhooks = false\n');
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  const config = readFileSync(path, "utf8");
  assert.match(config, /model = "gpt-5"/);
  assert.match(config, /memories = true/);
  assert.equal(config.match(/^hooks = true$/gm)?.length, 1);
});

test("install-hooks --stop refuses a non-Git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-hooks-not-git-"));
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 1);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("the shared runner converts infrastructure failures into each client's blocking protocol", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);
  writeFileSync(join(dir, ".agents", "manifest.yaml"), "spec: v\nidentity: { name: test }\n");
  const runner = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  const env = { ...process.env, HARNESS_KIT_CMD: "false" };

  const cursor = spawnSync("bash", [runner, "cursor", "stop"], { cwd: dir, input: "{}", encoding: "utf8", env });
  assert.equal(cursor.status, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /infrastructure failed/);

  const codex = spawnSync("bash", [runner, "codex", "stop"], { cwd: dir, input: "{}", encoding: "utf8", env });
  assert.equal(codex.status, 0);
  assert.equal(JSON.parse(codex.stdout).decision, "block");

  const claudeStart = spawnSync("bash", [runner, "claude", "session-start"], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
    env,
  });
  assert.equal(claudeStart.status, 2);
  assert.match(claudeStart.stderr, /infrastructure failed/);
});

test("installed outer commands still block when the shared runner is missing", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);
  unlinkSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh"));

  const claude = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  const claudeStart = spawnSync("bash", ["-lc", claude.hooks.SessionStart[0].hooks[0].command], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(claudeStart.status, 2);
  assert.match(claudeStart.stderr, /runner is missing/);

  const cursor = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
  const cursorStop = spawnSync("bash", ["-lc", cursor.hooks.stop[0].command], { cwd: dir, input: "{}", encoding: "utf8" });
  assert.equal(cursorStop.status, 0);
  assert.match(JSON.parse(cursorStop.stdout).followup_message, /runner is missing/);

  const codex = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  const codexStop = spawnSync("bash", ["-lc", codex.hooks.Stop[0].hooks[0].command], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(codexStop.status, 0);
  assert.equal(JSON.parse(codexStop.stdout).decision, "block");
});
