import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planChecksCmd } from "../src/commands/plan-checks";
import { runChecksCmd, type RunChecksOpts } from "../src/commands/run-checks";
import { readLatestValidationSession } from "../src/validation-state";

// A fresh git repo. We rely on untracked files counting as "changed" (git
// ls-files --others), so no commit/author config is needed.
function freshRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-rc-"));
  execSync("git init -q", { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// Capture the JSON that run-checks writes to stdout, plus its exit code.
function captureJson(fn: () => number): { code: number; json: any } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  let code: number;
  try {
    code = fn();
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, json: JSON.parse(chunks.join("")) };
}

function runJson(repo: string, opts: Partial<RunChecksOpts> = {}): { code: number; json: any } {
  return captureJson(() => runChecksCmd(repo, { json: true, ...opts }));
}

const MANIFEST = `spec: ai-harness/v0
identity: { name: t, summary: s }
capabilities:
  test: { run: "true" }
  typecheck: { run: "true" }
  deploy: { run: "true", mutating: true }
modules:
  - name: api
    role: r
    entry: ["src/api/users.ts"]
    owns: ["src/api/**"]
    tests: ["test/api/**"]
    checks: ["test"]
`;

test("run-checks passes when prod + tests changed and the check succeeds", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST,
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.equal(json.status, "verified-with-advisories");
  assert.ok(json.passed.includes("test"));
});

test("run-checks fails (blocking gap) when prod changed but no test touched", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('checks: ["test"]', 'checks: ["test"]\n    test_touch: required'),
    "src/api/users.ts": "export const x = 1;\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.ok(json.gaps.some((g: any) => g.kind === "missing-test-touch" && g.severity === "blocking"));
});

test("--waive lets a blocking gap through and records the reason", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('checks: ["test"]', 'checks: ["test"]\n    test_touch: required'),
    "src/api/users.ts": "export const x = 1;\n",
  });
  const { code, json } = runJson(repo, { waive: "missing-test-touch", where: "api", reason: "hotfix" });
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.equal(json.status, "verified-with-waivers");
  assert.ok(json.waivers.some((w: any) => w.kind === "missing-test-touch" && w.reason === "hotfix"));
});

test("--waive cannot bypass an unknown profile or other execution/configuration failures", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST,
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo, { profile: "missing", waive: "unknown-profile", where: "missing", reason: "skip" });
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /cannot be waived/.test(e)));
  assert.equal(json.waivers.length, 0);
});

test("run-checks reports a failing check as failed with nonzero exit", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('test: { run: "true" }', 'test: { run: "false" }'),
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.ok(json.failed.some((f: any) => f.id === "test"));
});

test("a verbose successful check is not mistaken for an ENOBUFS failure", () => {
  const command = `node -e "process.stdout.write('x'.repeat(2 * 1024 * 1024))"`;
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('test: { run: "true" }', `test: { run: "${command.replaceAll('"', '\\"')}" }`),
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 0);
  assert.ok(json.passed.includes("test"));
});

test("mutating/background capabilities cannot produce a successful verification", () => {
  const manifest = MANIFEST.replace('checks: ["test"]', 'checks: ["test", "deploy"]');
  const repo = freshRepo({
    ".agents/manifest.yaml": manifest,
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /mutating/.test(e)));
});

test("an unknown selected capability is manifest-invalid, not a successful skip", () => {
  const manifest = MANIFEST.replace('checks: ["test"]', 'checks: ["ghost"]');
  const repo = freshRepo({
    ".agents/manifest.yaml": manifest,
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /ghost/.test(e)));
});

test("a waiver requires a non-empty reason", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('checks: ["test"]', 'checks: ["test"]\n    test_touch: required'),
    "src/api/users.ts": "export const x = 1;\n",
  });
  const { code, json } = runJson(repo, { waive: "missing-test-touch", where: "api", reason: "" });
  assert.equal(code, 1);
  assert.ok(json.errors.some((e: string) => /reason/.test(e)));
});

test("a waiver requires an explicit exact scope", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('checks: ["test"]', 'checks: ["test"]\n    test_touch: required'),
    "src/api/users.ts": "export const x = 1;\n",
  });
  const { code, json } = runJson(repo, { waive: "missing-test-touch", reason: "hotfix" });
  assert.equal(code, 1);
  assert.ok(json.errors.some((e: string) => /scope|--where/.test(e)));
});

test("a malformed manifest can never produce a successful empty verification", () => {
  const repo = freshRepo({ ".agents/manifest.yaml": "null\n", "src/api/users.ts": "export const x = 1;\n" });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /manifest-invalid/.test(e)));
});

test("an invalid git base fails closed instead of looking like a clean change", () => {
  const repo = freshRepo({ ".agents/manifest.yaml": MANIFEST, "src/api/users.ts": "export const x = 1;\n" });
  const { code, json } = runJson(repo, { base: "definitely-not-a-ref" });
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /invalid-base/.test(e)));
});

test("a check that mutates the change invalidates its own evidence", () => {
  const command = `node -e "require('fs').appendFileSync('src/api/users.ts','x')"`;
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('test: { run: "true" }', `test: { run: "${command.replaceAll('"', '\\"')}" }`),
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// covers x\n",
  });
  const { code, json } = runJson(repo);
  assert.equal(code, 1);
  assert.equal(json.status, "not-verified");
  assert.ok(json.errors.some((e: string) => /fingerprint changed/.test(e)));
});

test("an implicit manual no-change result cannot prove an already-committed task", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST,
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// initial coverage\n",
  });
  execSync("git add .", { cwd: repo });
  execSync('git -c user.name="Harness Test" -c user.email="harness@example.test" commit -qm initial', { cwd: repo });

  const implicit = runJson(repo);
  assert.equal(implicit.code, 1);
  assert.equal(implicit.json.status, "not-verified");
  assert.ok(implicit.json.gaps.some((gap: any) => gap.kind === "manual-base-required"));

  const explicit = runJson(repo, { base: "HEAD" });
  assert.equal(explicit.code, 0);
  assert.equal(explicit.json.status, "no-change");
});

test("a staged test modification followed by a worktree deletion still blocks required test touch", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": MANIFEST.replace('checks: ["test"]', 'checks: ["test"]\n    test_touch: required'),
    "src/api/users.ts": "export const x = 1;\n",
    "test/api/users.test.ts": "// initial coverage\n",
  });
  execSync("git add .", { cwd: repo });
  execSync('git -c user.name="Harness Test" -c user.email="harness@example.test" commit -qm initial', { cwd: repo });
  writeFileSync(join(repo, "src/api/users.ts"), "export const x = 2;\n");
  writeFileSync(join(repo, "test/api/users.test.ts"), "// staged coverage\n");
  execSync("git add src/api/users.ts test/api/users.test.ts", { cwd: repo });
  unlinkSync(join(repo, "test/api/users.test.ts"));

  const planned = captureJson(() => planChecksCmd(repo, { base: "HEAD", json: true }));
  assert.equal(planned.code, 0);
  assert.ok(planned.json.gaps.some((gap: any) => gap.kind === "missing-test-touch" && gap.severity === "blocking"));

  const { code, json } = runJson(repo, { base: "HEAD" });
  assert.equal(code, 1);
  assert.ok(json.gaps.some((gap: any) => gap.kind === "missing-test-touch" && gap.severity === "blocking"));
});

test("a nested harness target sees target-relative changes and excludes sibling packages", () => {
  const manifest = `spec: ai-harness/v0
identity: { name: nested, summary: nested fixture }
capabilities:
  test: { run: "true" }
modules:
  - name: core
    role: nested core
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
validation:
  required_coverage: [src/**]
`;
  const repo = freshRepo({
    "packages/a/.agents/manifest.yaml": manifest,
    "packages/a/src/core.ts": "export const value = 1;\n",
    "packages/a/test/core.test.ts": "// initial\n",
    "packages/b/src/other.ts": "export const other = 1;\n",
    "packages/b/test/other.test.ts": "// initial\n",
  });
  execSync("git add .", { cwd: repo });
  execSync('git -c user.name="Harness Test" -c user.email="harness@example.test" commit -qm initial', { cwd: repo });
  writeFileSync(join(repo, "packages/a/src/core.ts"), "export const value = 2;\n");
  writeFileSync(join(repo, "packages/b/src/other.ts"), "export const other = 2;\n");
  writeFileSync(join(repo, "packages/b/test/other.test.ts"), "// covers sibling only\n");
  execSync("git add packages/a/src/core.ts packages/b/src/other.ts packages/b/test/other.test.ts", { cwd: repo });

  const target = join(repo, "packages/a");
  const missing = runJson(target, { base: "HEAD" });
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.json.changed, ["src/core.ts"]);
  assert.ok(missing.json.gaps.some((gap: any) => gap.kind === "missing-test-touch" && gap.where === "core"));

  writeFileSync(join(repo, "packages/a/test/core.test.ts"), "// covers value 2\n");
  const covered = runJson(target, { base: "HEAD" });
  assert.equal(covered.code, 0);
  assert.deepEqual(covered.json.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.equal(covered.json.status, "verified");
});

test("run-checks executes mandatory gate checks and unit test touch cannot satisfy gate acceptance", () => {
  const manifest = `spec: ai-harness/v1
identity: { name: desktop, summary: desktop fixture }
capabilities:
  unit: { run: "true" }
  desktop-e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    tests: [test/unit/**]
    checks: [unit]
    test_touch: required
    gates: [desktop-user-flow]
validation:
  gates:
    desktop-user-flow:
      checks: [desktop-e2e]
      acceptance:
        tests: [e2e/desktop/**]
        test_touch: required
  checksets:
    fast: { checks: [unit] }
`;
  const unitOnly = freshRepo({
    ".agents/manifest.yaml": manifest,
    "src/renderer/page.ts": "export const page = 1;\n",
    "test/unit/page.test.ts": "// unit coverage\n",
  });
  const blocked = runJson(unitOnly);
  assert.equal(blocked.code, 1);
  assert.ok(blocked.json.passed.includes("unit"));
  assert.ok(blocked.json.passed.includes("desktop-e2e"));
  assert.deepEqual(blocked.json.gates, ["desktop-user-flow"]);
  assert.ok(blocked.json.gaps.some((gap: any) => gap.kind === "missing-test-touch" && gap.where === "gate:desktop-user-flow"));

  const accepted = freshRepo({
    ".agents/manifest.yaml": manifest,
    "src/renderer/page.ts": "export const page = 1;\n",
    "test/unit/page.test.ts": "// unit coverage\n",
    "e2e/desktop/page.spec.ts": "// desktop acceptance\n",
  });
  const passed = runJson(accepted);
  assert.equal(passed.code, 0);
  assert.ok(passed.json.passed.includes("desktop-e2e"));
  assert.deepEqual(passed.json.gates, ["desktop-user-flow"]);
  assert.match(passed.json.planFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(readLatestValidationSession(accepted)?.lastEvidence?.gates, ["desktop-user-flow"]);
  assert.equal(readLatestValidationSession(accepted)?.lastEvidence?.planFingerprint, passed.json.planFingerprint);

  const profiled = runJson(accepted, { profile: "fast" });
  assert.equal(profiled.code, 0);
  assert.ok(profiled.json.passed.includes("unit"));
  assert.ok(profiled.json.passed.includes("desktop-e2e"), "a fast profile cannot bypass the gate command");
});

test("run-checks fails closed after the last required acceptance case is deleted even if the runner exits zero", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": `spec: ai-harness/v1
identity: { name: deletion, summary: deletion fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    gates: [flow]
validation:
  gates:
    flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
    "src/page.ts": "export const page = 1;\n",
    "e2e/only.spec.ts": "// only acceptance case\n",
  });
  execSync("git add .", { cwd: repo });
  execSync('git -c user.name="Harness Test" -c user.email="harness@example.test" commit -qm initial', { cwd: repo });
  unlinkSync(join(repo, "e2e/only.spec.ts"));

  const result = runJson(repo, { base: "HEAD" });
  assert.equal(result.code, 1);
  assert.ok(result.json.passed.includes("e2e"), "the zero-exit runner still executed");
  assert.ok(
    result.json.gaps.some(
      (gap: any) => gap.kind === "validation-gate-invalid" && gap.where === "gate:flow" && /matches 0 files/.test(gap.why),
    ),
  );
});

test("an unreferenced check-only gate is manifest-invalid instead of silently running unit-only", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": `spec: ai-harness/v1
identity: { name: orphan-gate, summary: orphan gate fixture }
capabilities:
  unit: { run: "true" }
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    checks: [unit]
validation:
  gates:
    user-flow:
      checks: [e2e]
`,
    "src/page.ts": "export const page = 1;\n",
  });

  const result = runJson(repo);
  assert.equal(result.code, 1);
  assert.equal(result.json.status, "not-verified");
  assert.deepEqual(result.json.passed, []);
  assert.ok(result.json.errors.some((error: string) => /manifest-invalid: validation gate user-flow 未被任何 module\.gates 引用/.test(error)));
});

test("a failing validation gate command blocks delivery", () => {
  const repo = freshRepo({
    ".agents/manifest.yaml": `spec: ai-harness/v1
identity: { name: failing-gate, summary: failing gate fixture }
capabilities:
  e2e: { run: "node -e 'process.exit(7)'" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    gates: [flow]
validation:
  gates:
    flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
    "src/page.ts": "export const page = 1;\n",
    "e2e/page.spec.ts": "// acceptance\n",
  });

  const result = runJson(repo);
  assert.equal(result.code, 1);
  assert.ok(result.json.failed.some((failure: any) => failure.id === "e2e" && failure.code === 7));
});
