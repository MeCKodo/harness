import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest";
import type { Manifest } from "../src/manifest";

test("a minimal valid manifest produces no errors", () => {
  const m: Manifest = { spec: "ai-harness/v0", identity: { name: "x", summary: "s" } };
  const errs = validateManifest(m).filter((i) => i.level === "error");
  assert.equal(errs.length, 0);
});

test("missing spec and identity.name are reported as errors", () => {
  const m = { identity: {} } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /spec/.test(e)));
  assert.ok(errs.some((e) => /identity\.name/.test(e)));
});

test("duplicate invariant id is an error", () => {
  const m: Manifest = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "dup", rule: "r1", manual: true },
      { id: "dup", rule: "r2", manual: true },
    ],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /重复: dup/.test(e)));
});

test("routing verify referencing an unknown capability warns", () => {
  const m: Manifest = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    routing: [{ when: "fix", verify: ["nonexistent"] }],
  };
  const warns = validateManifest(m)
    .filter((i) => i.level === "warn")
    .map((i) => i.msg);
  assert.ok(warns.some((w) => /未声明的 capability/.test(w)));
});
