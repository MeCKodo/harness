import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planChecksCmd } from "../src/commands/plan-checks";
import { runChecksCmd, type RunChecksOpts } from "../src/commands/run-checks";

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

const MANIFEST = `spec: v
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
  const manifest = `spec: v
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
