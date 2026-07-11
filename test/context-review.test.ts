import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Manifest } from "../src/manifest";
import {
  inspectContextFreshness,
  recordContextReview,
  resolveKnowledgePath,
} from "../src/state";

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(): { repo: string; manifest: Manifest } {
  const repo = mkdtempSync(join(tmpdir(), "hk-context-"));
  write(repo, "src/api.ts", "export const route = '/v1/user';\n");
  write(repo, "engineering/handbook/api.md", "The route is /v1/user.\n");
  write(repo, ".agents/knowledge/policy.md", "Never log tokens.\n");
  const manifest: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "context-fixture", summary: "context fixture" },
    knowledge: [
      {
        root: "repo",
        path: "engineering/handbook/api.md",
        role: "api",
        authority: "derived",
        binds: ["src/api.ts"],
      },
      {
        root: "agents",
        path: "knowledge/policy.md",
        role: "policy",
        authority: "policy",
        binds: ["src/api.ts"],
      },
    ],
  };
  return { repo, manifest };
}

test("knowledge root resolves arbitrary repository paths without hard-coded folder names", () => {
  const { repo, manifest } = fixture();
  assert.equal(
    resolveKnowledgePath(repo, manifest.knowledge![0]),
    join(repo, "engineering/handbook/api.md"),
  );
  assert.equal(resolveKnowledgePath(repo, manifest.knowledge![1]), join(repo, ".agents/knowledge/policy.md"));
});

test("explicit-authority knowledge is blocking until an Agent records its review", () => {
  const { repo, manifest } = fixture();
  const issues = inspectContextFreshness(repo, manifest);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.severity === "blocking"));
  assert.ok(issues.every((issue) => /尚未记录复核/.test(issue.reason)));
});

test("record-context-review captures source and knowledge hashes and becomes stale after either changes", () => {
  const { repo, manifest } = fixture();
  const recorded = recordContextReview(repo, manifest, {
    path: "engineering/handbook/api.md",
    reason: "initial code-backed onboarding review",
    session: "agent-session-1",
  });
  assert.equal(recorded.reason, "initial code-backed onboarding review");
  assert.equal(recorded.session, "agent-session-1");
  assert.deepEqual(inspectContextFreshness(repo, manifest).map((issue) => issue.key), ["knowledge:agents:knowledge/policy.md"]);

  write(repo, "src/api.ts", "export const route = '/v2/users';\n");
  const sourceIssue = inspectContextFreshness(repo, manifest).find((issue) => issue.key === "knowledge:repo:engineering/handbook/api.md");
  assert.deepEqual(sourceIssue?.changedSources, ["src/api.ts"]);

  recordContextReview(repo, manifest, {
    path: "engineering/handbook/api.md",
    reason: "route behavior reviewed; documentation updated separately",
  });
  write(repo, "engineering/handbook/api.md", "The route is /v2/users.\n");
  const contentIssue = inspectContextFreshness(repo, manifest).find((issue) => issue.key === "knowledge:repo:engineering/handbook/api.md");
  assert.match(contentIssue?.reason ?? "", /知识内容在复核后发生变化/);
});

test("record-context-review requires one exact target and a non-empty reason", () => {
  const { repo, manifest } = fixture();
  assert.throws(() => recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", reason: "  " }), /reason/);
  assert.throws(() => recordContextReview(repo, manifest, { path: "missing.md", reason: "reviewed" }), /未声明/);
  assert.throws(
    () => recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", module: "core", reason: "reviewed" }),
    /只能指定一个/,
  );
});

test("a review becomes stale when its binds are removed or its authority changes", () => {
  const first = fixture();
  recordContextReview(first.repo, first.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed the original derived source binding",
  });
  first.manifest.knowledge![0]!.binds = [];
  const removedBind = inspectContextFreshness(first.repo, first.manifest).find(
    (issue) => issue.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.deepEqual(removedBind?.changedSources, ["src/api.ts"]);

  const second = fixture();
  recordContextReview(second.repo, second.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed as derived documentation",
  });
  second.manifest.knowledge![0]!.authority = "policy";
  const changedAuthority = inspectContextFreshness(second.repo, second.manifest).find(
    (issue) => issue.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.match(changedAuthority?.reason ?? "", /authority.*derived.*policy/);
});

test("an implicit-authority review becomes blocking when the registered knowledge loses all binds", () => {
  const current = fixture();
  delete current.manifest.knowledge![0]!.authority;
  recordContextReview(current.repo, current.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed the original implicit source binding",
  });
  current.manifest.knowledge![0]!.binds = [];

  const issue = inspectContextFreshness(current.repo, current.manifest).find(
    (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.equal(issue?.severity, "blocking", "persisted review must not disappear while the knowledge remains registered");
  assert.match(issue?.reason ?? "", /orphan review/);
  assert.deepEqual(issue?.changedSources, ["src/api.ts"]);

  current.manifest.knowledge = current.manifest.knowledge!.slice(1);
  assert.ok(
    !inspectContextFreshness(current.repo, current.manifest).some(
      (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
    ),
    "removing the knowledge registration is an explicit resolution, not a permanent orphan",
  );
});

test("missing bound sources can neither be recorded nor treated as current", () => {
  const { repo, manifest } = fixture();
  unlinkSync(join(repo, "src/api.ts"));

  assert.throws(
    () =>
      recordContextReview(repo, manifest, {
        path: "engineering/handbook/api.md",
        reason: "cannot truthfully review a missing source",
      }),
    /source missing.*src\/api\.ts/,
  );
  const issue = inspectContextFreshness(repo, manifest).find(
    (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.match(issue?.reason ?? "", /绑定源文件缺失/);
  assert.deepEqual(issue?.changedSources, ["src/api.ts"]);
});
