import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import type { Knowledge, Manifest, Module } from "./manifest";
import { hashFile, readText, sha256, writeText } from "./util";

const STATE_REL = ".agents/.harness-state.json";

export interface ContextReviewRecord {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  authority: "derived" | "policy" | "review";
  contentHash: string;
  sources: Record<string, string>;
  reason: string;
  session?: string;
  reviewedAt: string;
}

export interface HarnessState {
  // Legacy v0.2 freshness baseline. Kept readable so existing manifests retain
  // advisory drift instead of becoming a breaking migration.
  bindings: Record<string, Record<string, string>>;
  reviews?: Record<string, ContextReviewRecord>;
}

export interface ContextFreshnessIssue {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  severity: "blocking" | "advisory";
  reason: string;
  changedSources: string[];
}

interface ContextSnapshot {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  authority?: "derived" | "policy" | "review";
  contentHash: string;
  sources: Record<string, string>;
  legacyKey: string;
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveKnowledgePath(repo: string, knowledge: Knowledge): string {
  const base = knowledge.root === "repo" ? resolve(repo) : resolve(repo, ".agents");
  const target = resolve(base, knowledge.path);
  if (!inside(base, target)) throw new Error(`knowledge path escapes ${knowledge.root === "repo" ? "repository" : ".agents"}: ${knowledge.path}`);
  return target;
}

function hashPath(absPath: string): string {
  if (!existsSync(absPath)) return "(missing)";
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return "(missing)";
  }
  if (stat.isFile()) return hashFile(absPath) ?? "(missing)";
  if (!stat.isDirectory()) return "(missing)";
  const files = fg.sync("**/*", { cwd: absPath, onlyFiles: true, dot: true, followSymbolicLinks: false }).sort();
  const entries = files.map((path) => [path, hashFile(join(absPath, path)) ?? "(missing)"]);
  return sha256(JSON.stringify(entries));
}

function sourceHashes(repo: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of paths) result[path] = hashFile(join(repo, path)) ?? "(missing)";
  return result;
}

function knowledgeKey(knowledge: Knowledge): string {
  return `knowledge:${knowledge.root ?? "agents"}:${knowledge.path}`;
}

function moduleContentHash(module: Module): string {
  return sha256(
    JSON.stringify({
      name: module.name,
      role: module.role,
      entry: module.entry,
      upstream: module.upstream ?? [],
      downstream: module.downstream ?? [],
      must_know: module.must_know ?? [],
      pitfalls: module.pitfalls ?? [],
      owns: module.owns ?? [],
      tests: module.tests ?? [],
      checks: module.checks ?? [],
      test_touch: module.test_touch ?? null,
      playbook: module.playbook ?? null,
      remediation: module.remediation ?? null,
    }),
  );
}

function contextSnapshots(repo: string, manifest: Manifest): ContextSnapshot[] {
  const snapshots: ContextSnapshot[] = [];
  for (const knowledge of manifest.knowledge ?? []) {
    if (!knowledge.binds?.length && !knowledge.authority) continue;
    snapshots.push({
      key: knowledgeKey(knowledge),
      kind: "knowledge",
      target: knowledge.path,
      authority: knowledge.authority,
      contentHash: hashPath(resolveKnowledgePath(repo, knowledge)),
      sources: sourceHashes(repo, knowledge.binds ?? []),
      legacyKey: knowledge.path,
    });
  }
  for (const module of manifest.modules ?? []) {
    if (!module.entry?.length) continue;
    const key = `module:${module.name}`;
    snapshots.push({
      key,
      kind: "module",
      target: module.name,
      authority: undefined,
      contentHash: moduleContentHash(module),
      sources: sourceHashes(repo, module.entry),
      legacyKey: key,
    });
  }
  return snapshots;
}

export function computeBindings(repo: string, manifest: Manifest): HarnessState {
  const bindings: HarnessState["bindings"] = {};
  for (const snapshot of contextSnapshots(repo, manifest)) bindings[snapshot.legacyKey] = snapshot.sources;
  return { bindings };
}

export function readState(repo: string): HarnessState | null {
  const raw = readText(join(repo, STATE_REL));
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<HarnessState>;
  return { bindings: value.bindings ?? {}, reviews: value.reviews ?? {} };
}

export function writeState(repo: string, state: HarnessState): void {
  writeText(join(repo, STATE_REL), JSON.stringify(state, null, 2) + "\n");
}

function changedSources(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function missingSources(snapshot: ContextSnapshot): string[] {
  return Object.entries(snapshot.sources)
    .filter(([, hash]) => hash === "(missing)")
    .map(([path]) => path)
    .sort();
}

export function inspectContextFreshness(repo: string, manifest: Manifest): ContextFreshnessIssue[] {
  const state = readState(repo);
  const issues: ContextFreshnessIssue[] = [];
  const snapshots = contextSnapshots(repo, manifest);
  const currentKeys = new Set(snapshots.map((snapshot) => snapshot.key));
  const registeredKnowledgeKeys = new Set((manifest.knowledge ?? []).map(knowledgeKey));
  for (const snapshot of snapshots) {
    const review = state?.reviews?.[snapshot.key];
    const missing = missingSources(snapshot);
    if (missing.length) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "blocking",
        reason: "绑定源文件缺失，不能把上下文视为已复核",
        changedSources: missing,
      });
      continue;
    }
    const expectedAuthority = snapshot.authority ?? "review";
    if (review && review.authority !== expectedAuthority) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "blocking",
        reason: `authority 在复核后从 ${review.authority} 变为 ${expectedAuthority}`,
        changedSources: changedSources(review.sources, snapshot.sources),
      });
      continue;
    }
    if (snapshot.authority) {
      if (!review) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          reason: `尚未记录复核（authority: ${snapshot.authority}）`,
          changedSources: Object.keys(snapshot.sources).sort(),
        });
        continue;
      }
      const sources = changedSources(review.sources, snapshot.sources);
      if (review.contentHash !== snapshot.contentHash) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          reason: "知识内容在复核后发生变化，必须重新记录复核",
          changedSources: sources,
        });
      } else if (sources.length) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          reason: `绑定源文件在复核后发生变化（authority: ${snapshot.authority}）`,
          changedSources: sources,
        });
      }
      continue;
    }

    // Once a legacy/module context has an explicit review, keep that review
    // durable and blocking. Otherwise preserve the v0.2 advisory baseline.
    if (review) {
      const sources = changedSources(review.sources, snapshot.sources);
      if (review.contentHash !== snapshot.contentHash || sources.length) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          reason: review.contentHash !== snapshot.contentHash ? "上下文内容在复核后发生变化" : "绑定源文件在复核后发生变化",
          changedSources: sources,
        });
      }
      continue;
    }
    const legacy = state?.bindings?.[snapshot.legacyKey];
    if (!legacy) continue;
    const sources = changedSources(legacy, snapshot.sources);
    if (sources.length) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "advisory",
        reason: "legacy freshness baseline changed; record a context review to make it durable",
        changedSources: sources,
      });
    }
  }
  for (const [key, review] of Object.entries(state?.reviews ?? {})) {
    if (currentKeys.has(key)) continue;
    if (review.kind !== "knowledge" || !registeredKnowledgeKeys.has(key)) continue;
    issues.push({
      key,
      kind: review.kind,
      target: review.target,
      severity: "blocking",
      reason: "orphan review: 已复核的 knowledge 仍在 manifest 中，但不再声明 binds/authority，已有复核不能静默消失",
      changedSources: Object.keys(review.sources ?? {}).sort(),
    });
  }
  return issues;
}

export interface RecordContextReviewOpts {
  path?: string;
  module?: string;
  reason: string;
  session?: string;
}

export function recordContextReview(repo: string, manifest: Manifest, opts: RecordContextReviewOpts): ContextReviewRecord {
  if (!!opts.path === !!opts.module) throw new Error("只能指定一个 --path 或 --module");
  const reason = opts.reason?.trim();
  if (!reason) throw new Error("record-context-review requires a non-empty --reason");

  const snapshots = contextSnapshots(repo, manifest);
  let snapshot: ContextSnapshot | undefined;
  if (opts.path) {
    const matches = (manifest.knowledge ?? []).filter((knowledge) => knowledge.path === opts.path);
    if (matches.length !== 1) throw new Error(matches.length ? `knowledge path 有歧义: ${opts.path}` : `manifest 未声明 knowledge path: ${opts.path}`);
    snapshot = snapshots.find((item) => item.key === knowledgeKey(matches[0]));
  } else {
    snapshot = snapshots.find((item) => item.kind === "module" && item.target === opts.module);
    if (!snapshot) throw new Error(`manifest 未声明可复核 module: ${opts.module}`);
  }
  if (!snapshot) throw new Error(`context 没有 binds/entry，无法记录复核: ${opts.path ?? opts.module}`);
  if (snapshot.contentHash === "(missing)") throw new Error(`context target missing: ${snapshot.target}`);
  const missing = missingSources(snapshot);
  if (missing.length) throw new Error(`context source missing: ${missing.join(", ")}`);

  const record: ContextReviewRecord = {
    key: snapshot.key,
    kind: snapshot.kind,
    target: snapshot.target,
    authority: snapshot.authority ?? "review",
    contentHash: snapshot.contentHash,
    sources: snapshot.sources,
    reason,
    ...(opts.session ? { session: opts.session } : {}),
    reviewedAt: new Date().toISOString(),
  };
  const state = readState(repo) ?? { bindings: {} };
  writeState(repo, { ...state, reviews: { ...(state.reviews ?? {}), [record.key]: record } });
  return record;
}
