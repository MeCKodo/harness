import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBindings } from "../src/state";
import type { Manifest } from "../src/manifest";

function repoWith(content: string): { repo: string; m: Manifest } {
  const repo = mkdtempSync(join(tmpdir(), "harness-state-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/server.ts"), content);
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "t", summary: "s" },
    knowledge: [{ path: "knowledge/domain.md", binds: ["src/server.ts"] }],
    modules: [{ name: "core", role: "backend", entry: ["src/server.ts"] }],
  };
  return { repo, m };
}

test("computeBindings hashes both knowledge.binds and module.entry", () => {
  const { repo, m } = repoWith("a\n");
  const s = computeBindings(repo, m);
  assert.ok(s.bindings["knowledge/domain.md"]["src/server.ts"]);
  assert.ok(s.bindings["module:core"]["src/server.ts"]);
});

test("hash changes when a bound file changes (this is the drift signal)", () => {
  const { repo, m } = repoWith("a\n");
  const before = computeBindings(repo, m).bindings["module:core"]["src/server.ts"];
  writeFileSync(join(repo, "src/server.ts"), "b\n");
  const after = computeBindings(repo, m).bindings["module:core"]["src/server.ts"];
  assert.notEqual(before, after);
});

test("a missing bound file is recorded as (missing), not a crash", () => {
  const repo = mkdtempSync(join(tmpdir(), "harness-state-"));
  const m: Manifest = {
    spec: "v",
    identity: { name: "t", summary: "s" },
    knowledge: [{ path: "k", binds: ["nope.ts"] }],
  };
  const s = computeBindings(repo, m);
  assert.equal(s.bindings["k"]["nope.ts"], "(missing)");
});

test("a directory entry does not crash with EISDIR (recorded as (missing))", () => {
  const repo = mkdtempSync(join(tmpdir(), "harness-state-"));
  mkdirSync(join(repo, "src"), { recursive: true }); // entry points at a directory
  const m: Manifest = {
    spec: "v",
    identity: { name: "t", summary: "s" },
    modules: [{ name: "core", role: "r", entry: ["src"] }],
  };
  const s = computeBindings(repo, m);
  assert.equal(s.bindings["module:core"]["src"], "(missing)");
});
