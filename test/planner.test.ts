import { test } from "node:test";
import assert from "node:assert/strict";
import { planChecks } from "../src/planner";
import type { Manifest } from "../src/manifest";

const base: Manifest = { spec: "ai-harness/v0", identity: { name: "x", summary: "s" } };

function withModules(extra: Partial<Manifest>): Manifest {
  return { ...base, capabilities: { test: { run: "t" }, typecheck: { run: "tc" } }, ...extra };
}

test("owns maps a changed file to its module and selects that module's checks", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
  });
  const p = planChecks(m, ["src/api/users.ts", "test/api/users.test.ts"]);
  assert.deepEqual(p.affected, ["api"]);
  assert.ok(p.checks.some((c) => c.id === "test" && c.reason === "module:api"));
  // test file was touched -> no missing-test-touch gap
  assert.ok(!p.gaps.some((g) => g.kind === "missing-test-touch"));
  assert.ok(!p.gaps.some((g) => g.kind === "unmapped-file"), "declared test files are mapped too");
});

test("changing prod code without touching tests yields a blocking missing-test-touch gap", () => {
  const m = withModules({
    modules: [
      { name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"], test_touch: "required" },
    ],
  });
  const p = planChecks(m, ["src/api/users.ts"]);
  const gap = p.gaps.find((g) => g.kind === "missing-test-touch");
  assert.ok(gap, "missing-test-touch present");
  assert.equal(gap!.severity, "blocking");
  assert.equal(gap!.where, "api");
});

test("deleting a test file does not satisfy required test touch", () => {
  const m = withModules({
    modules: [
      { name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"], test_touch: "required" },
    ],
  });
  const plan = planChecks(m, [
    { path: "src/api/users.ts", status: "M" },
    { path: "test/api/users.test.ts", status: "D" },
  ]);
  assert.equal(plan.gaps.find((gap) => gap.kind === "missing-test-touch")?.severity, "blocking");
});

test("the final worktree deletion wins over an earlier staged test modification", () => {
  const m = withModules({
    modules: [
      { name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"], test_touch: "required" },
    ],
  });
  const plan = planChecks(m, [
    { path: "src/api/users.ts", status: "M", layer: "index" },
    { path: "test/api/users.test.ts", status: "M", layer: "index" },
    { path: "test/api/users.test.ts", status: "D", layer: "worktree" },
  ]);
  assert.equal(plan.gaps.find((gap) => gap.kind === "missing-test-touch")?.severity, "blocking");
});

test("missing test touch is advisory by default and can be disabled", () => {
  const advisory = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
  });
  assert.equal(planChecks(advisory, ["src/api/users.ts"]).gaps.find((g) => g.kind === "missing-test-touch")?.severity, "advisory");

  const off = withModules({
    modules: [
      { name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"], test_touch: "off" },
    ],
  });
  assert.ok(!planChecks(off, ["src/api/users.ts"]).gaps.some((g) => g.kind === "missing-test-touch"));
});

test("a test-only change still selects the owning module checks", () => {
  const manifest = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
  });
  const plan = planChecks(manifest, ["test/api/users.test.ts"]);
  assert.deepEqual(plan.affected, ["api"]);
  assert.ok(plan.checks.some((check) => check.id === "test" && check.reason === "module:api"));
  assert.ok(!plan.gaps.some((gap) => gap.kind === "missing-test-touch"));
});

test("required coverage turns an unmapped production file into a blocking gap", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
    validation: { defaults: { no_match: ["typecheck"] }, required_coverage: ["src/**"] },
  });
  const gap = planChecks(m, ["src/unknown.ts"]).gaps.find((g) => g.kind === "unmapped-required-file");
  assert.equal(gap?.severity, "blocking");
});

test("an affected module without tests yields an advisory module-without-tests gap", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], checks: ["test"] }],
  });
  const p = planChecks(m, ["src/api/users.ts"]);
  const gap = p.gaps.find((g) => g.kind === "module-without-tests");
  assert.ok(gap);
  assert.equal(gap!.severity, "advisory");
});

test("test_touch off also disables the module-without-tests advisory", () => {
  const m = withModules({
    modules: [{ name: "generated", role: "r", entry: [], owns: ["generated/**"], checks: ["test"], test_touch: "off" }],
  });
  assert.ok(!planChecks(m, ["generated/client.ts"]).gaps.some((gap) => gap.kind === "module-without-tests"));
});

test("remediation overrides the default gap suggestion", () => {
  const m = withModules({
    modules: [
      { name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"], remediation: "ping @owner" },
    ],
  });
  const p = planChecks(m, ["src/api/users.ts"]);
  const gap = p.gaps.find((g) => g.kind === "missing-test-touch");
  assert.equal(gap!.suggestion, "ping @owner");
});

test("a file owned by nobody is an advisory unmapped-file gap", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
  });
  const p = planChecks(m, ["README.md"]);
  assert.ok(p.gaps.some((g) => g.kind === "unmapped-file"));
  assert.equal(p.affected.length, 0);
});

test("no module declares owns -> advisory no-impact-map gap", () => {
  const m = withModules({ modules: [{ name: "api", role: "r", entry: [] }] });
  const p = planChecks(m, ["src/api/users.ts"]);
  assert.ok(p.gaps.some((g) => g.kind === "no-impact-map"));
});

test("changes with no resolvable check produce a blocking no-checks-selected gap", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"] }], // no checks
  });
  const p = planChecks(m, ["src/api/users.ts", "test/api/users.test.ts"]);
  const gap = p.gaps.find((g) => g.kind === "no-checks-selected");
  assert.ok(gap);
  assert.equal(gap!.severity, "blocking");
});

test("defaults.no_match fires when nothing matched; defaults.always is added regardless", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
    validation: { defaults: { no_match: ["typecheck"], always: ["typecheck"] } },
  });
  const unmatched = planChecks(m, ["README.md"]);
  assert.ok(unmatched.checks.some((c) => c.id === "typecheck" && c.reason === "no_match"));
  const matched = planChecks(m, ["src/api/users.ts", "test/api/users.test.ts"]);
  assert.ok(matched.checks.some((c) => c.id === "typecheck" && c.reason === "always"));
});

test("--profile uses a checkset instead of per-module checks", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
    validation: { checksets: { full: { checks: ["test", "typecheck"] } } },
  });
  const p = planChecks(m, ["src/api/users.ts"], { profile: "full" });
  assert.ok(p.checks.every((c) => c.reason === "profile:full"));
  assert.deepEqual(new Set(p.checks.map((c) => c.id)), new Set(["test", "typecheck"]));
});

test("an unknown --profile is blocking even when always checks exist", () => {
  const m = withModules({
    validation: { checksets: { full: { checks: ["test"] } }, defaults: { always: ["typecheck"] } },
  });
  const plan = planChecks(m, ["README.md"], { profile: "ful" });
  assert.ok(plan.checks.some((check) => check.id === "typecheck"));
  assert.equal(plan.gaps.find((gap) => gap.kind === "unknown-profile")?.severity, "blocking");
});

test("checks are de-duplicated across modules, keeping the first reason", () => {
  const m = withModules({
    modules: [
      { name: "a", role: "r", entry: [], owns: ["a/**"], tests: ["a/t/**"], checks: ["test"] },
      { name: "b", role: "r", entry: [], owns: ["b/**"], tests: ["b/t/**"], checks: ["test"] },
    ],
  });
  const p = planChecks(m, ["a/x.ts", "a/t/x.test.ts", "b/y.ts", "b/t/y.test.ts"]);
  assert.equal(p.checks.filter((c) => c.id === "test").length, 1);
  assert.equal(p.checks.find((c) => c.id === "test")!.reason, "module:a");
});

test("propagation-note is emitted whenever a module is affected", () => {
  const m = withModules({
    modules: [{ name: "api", role: "r", entry: [], owns: ["src/api/**"], tests: ["test/api/**"], checks: ["test"] }],
  });
  const p = planChecks(m, ["src/api/users.ts", "test/api/users.test.ts"]);
  assert.ok(p.notes.some((n) => n.kind === "propagation-note"));
  assert.ok(!p.gaps.some((g) => g.kind === "propagation-note"));
});
