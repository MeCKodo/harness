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

test("module.checks must reference a declared capability (error)", () => {
  const m: Manifest = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: ["test", "ghost"] }],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /ghost/.test(e) && /capability/.test(e)));
});

test("validation checksets/defaults must reference declared capabilities (error)", () => {
  const m: Manifest = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    validation: {
      checksets: { ui: { checks: ["test", "phantom"] } },
      defaults: { no_match: ["nope"], always: ["test"] },
    },
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /phantom/.test(e)));
  assert.ok(errs.some((e) => /nope/.test(e)));
});

test("a validation checkset must declare its checks array", () => {
  const m = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    validation: { checksets: { full: {} } },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /checksets\.full\.checks.*必填/.test(message)));
});

test("a non-array where an array is expected is an error (Array.isArray guard)", () => {
  const m = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], owns: "src/**" }],
  } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /owns/.test(e) && /数组/.test(e)));
});

test("a non-object manifest root is rejected without throwing", () => {
  const errs = validateManifest(null as unknown as Manifest).filter((issue) => issue.level === "error");
  assert.match(errs[0]?.msg ?? "", /根节点/);
});

test("test-touch policy and required coverage shapes are validated", () => {
  const m = {
    spec: "v",
    identity: { name: "x" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], test_touch: "sometimes" }],
    validation: { policies: { test_touch_default: "always" }, required_coverage: "src/**" },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /test_touch/.test(message)));
  assert.ok(errors.some((message) => /required_coverage/.test(message)));
});

test("numeric routing.verify and module.checks report schema errors instead of throwing", () => {
  const m = {
    spec: "v",
    identity: { name: "x" },
    routing: [{ when: "fix", verify: 1 }],
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: 1 }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /routing.*verify/.test(message)));
  assert.ok(errors.some((message) => /module.*checks/.test(message)));
});

test("invariant execution controls reject quoted booleans and ambiguous manual checks", () => {
  const m = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "quoted", rule: "must run", manual: "false", enforcement: { forbid_pattern: ["bad"] } },
      { id: "ambiguous", rule: "choose one mode", manual: true, check: "true" },
    ],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /quoted\.manual.*布尔值/.test(message)));
  assert.ok(errors.some((message) => /ambiguous.*同时声明/.test(message)));
});

test("module.name must be a non-empty string", () => {
  const m = {
    spec: "v",
    identity: { name: "x", summary: "s" },
    modules: [{ name: 42, role: "r", entry: ["src/a.ts"] }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /module\.name.*字符串/.test(message)));
});
