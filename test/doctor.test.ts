import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorCmd } from "../src/commands/doctor";
import { syncCmd } from "../src/commands/sync";
import { loadManifest } from "../src/manifest";
import { recordContextReview } from "../src/state";

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function capture(fn: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { code: fn(), output: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
}

test("doctor accepts arbitrary repo-root knowledge, routing globs, and intentional empty enforcement", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-v03-"));
  write(repo, "src/api/route.ts", "export const route = '/v1';\n");
  write(repo, "engineering/handbook/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-v03, summary: doctor fixture }
knowledge:
  - { root: repo, path: engineering/handbook/api.md, role: api }
routing:
  - { when: change-api, read: ['src/api/**/*.ts'], entry: ['src/api/*.ts'] }
invariants:
  - id: intentionally-absent
    rule: removed workspace stays removed
    enforcement:
      path_glob: [pnpm-workspace.yaml]
      forbid_pattern: [packages]
      allow_empty: true
`,
  );
  syncCmd(repo);
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /knowledge: engineering\/handbook\/api\.md/);
  assert.doesNotMatch(result.output, /passes without checking anything/);
  assert.match(result.output, /Agent lifecycle hooks[\s\S]*DEGRADED/);
});

test("explicit authority is blocking until record-context-review is recorded", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-context-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(repo, "engineering/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-context, summary: context fixture }
knowledge:
  - root: repo
    path: engineering/api.md
    role: api
    authority: derived
    binds: [src/api.ts]
`,
  );
  syncCmd(repo);
  const before = capture(() => doctorCmd(repo));
  assert.equal(before.code, 1);
  assert.match(before.output, /尚未记录复核/);

  const manifest = loadManifest(repo);
  recordContextReview(repo, manifest, { path: "engineering/api.md", reason: "compared against current route implementation" });
  const after = capture(() => doctorCmd(repo));
  assert.equal(after.code, 0, after.output);
});

test("a routing glob that matches nothing is an actionable doctor error", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-route-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-route, summary: route fixture }
routing:
  - { when: missing, read: ['nowhere/**/*.ts'] }
`,
  );
  syncCmd(repo);
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /routing.*glob.*0 paths/);
});

test("doctor treats only the semantic CLAUDE.md -> AGENTS.md alias as in sync", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-alias-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: alias, summary: alias fixture }\n");
  symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLAUDE\.md.*semantic alias|CLAUDE\.md in sync/);
});
