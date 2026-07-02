import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface Capability {
  run: string;
  desc?: string;
  example?: string;
  background?: boolean;
  mutating?: boolean;
}

export interface EnvVar {
  name: string;
  desc?: string;
  required?: boolean;
  secret?: boolean;
}

export interface Contract {
  id: string;
  kind: string;
  desc: string;
  breaking_needs?: string;
  check?: string; // any command; exit 0 = compatible (repo brings its own breaking-change tool)
  snapshot?: string; // command that PRINTS the contract's current fingerprint to stdout; CLI diffs it vs a stored baseline (protocol-agnostic)
  manual_verify?: string; // how to verify by hand when no automatic check exists (honest gap)
}

export interface Enforcement {
  forbid_pattern?: string[];
  forbid_import?: string[];
  require_pattern?: string[];
  path_glob?: string[];
}

export interface Invariant {
  id: string;
  rule: string;
  enforcement?: Enforcement;
  check?: string;
  manual?: boolean;
  llm_judge?: boolean;
}

export interface Knowledge {
  path: string;
  role?: string;
  binds?: string[];
}

/** Change-type routing: tell the agent where to go per kind of change. */
export interface Route {
  when: string; // change type, e.g. "fix a bug", "add an HTTP endpoint"
  read?: string[]; // files/dirs to read first (repo-relative)
  entry?: string[]; // entry points
  dont_assume?: string[]; // gotchas to not guess about
  verify?: string[]; // minimum verification: capability verbs or raw commands
}

/** Module card: the per-module map that agents actually need. */
export interface Module {
  name: string;
  role: string;
  entry: string[]; // entry files (also used for freshness binding)
  upstream?: string[];
  downstream?: string[];
  must_know?: string[];
  pitfalls?: string[]; // common mistakes — the highest-value column
}

export interface Manifest {
  spec: string;
  identity: {
    name: string;
    summary?: string;
    scope_in?: string[];
    scope_out?: string[];
    upstream?: string[];
    downstream?: string[];
  };
  capabilities?: Record<string, Capability>;
  environment?: EnvVar[];
  contracts?: Contract[];
  invariants?: Invariant[];
  knowledge?: Knowledge[];
  routing?: Route[];
  modules?: Module[];
  playbooks?: { dir?: string };
}

export const MANIFEST_REL = ".agents/manifest.yaml";

export function manifestPath(repo: string): string {
  return join(repo, MANIFEST_REL);
}

export function loadManifest(repo: string): Manifest {
  const p = manifestPath(repo);
  if (!existsSync(p)) {
    throw new Error(`未找到 ${MANIFEST_REL}（在 ${repo}）。先跑 \`harness-kit init\`。`);
  }
  return YAML.parse(readFileSync(p, "utf8")) as Manifest;
}

export interface ValidationIssue {
  level: "error" | "warn";
  msg: string;
}

export function validateManifest(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!m.spec) issues.push({ level: "error", msg: "缺少 spec 字段" });
  if (!m.identity?.name) issues.push({ level: "error", msg: "identity.name 必填" });
  if (!m.identity?.summary) issues.push({ level: "warn", msg: "identity.summary 建议填写" });

  for (const [verb, cap] of Object.entries(m.capabilities ?? {})) {
    if (!cap?.run) issues.push({ level: "error", msg: `capabilities.${verb}.run 必填` });
  }
  const seen = new Set<string>();
  for (const inv of m.invariants ?? []) {
    if (!inv.id) {
      issues.push({ level: "error", msg: "存在缺少 id 的 invariant" });
      continue;
    }
    if (seen.has(inv.id)) issues.push({ level: "error", msg: `invariant id 重复: ${inv.id}` });
    seen.add(inv.id);
    if (!inv.enforcement && !inv.check && !inv.manual) {
      issues.push({ level: "warn", msg: `invariant ${inv.id} 既无 enforcement/check 也未标 manual` });
    }
  }

  const capVerbs = new Set(Object.keys(m.capabilities ?? {}));
  for (const r of m.routing ?? []) {
    if (!r.when) issues.push({ level: "error", msg: "存在缺少 when 的 routing 条目" });
    for (const v of r.verify ?? []) {
      // a verify step is either a known capability verb or a raw command (has a space)
      if (!v.includes(" ") && !capVerbs.has(v))
        issues.push({ level: "warn", msg: `routing "${r.when}" 的 verify 引用了未声明的 capability: ${v}` });
    }
  }

  const modSeen = new Set<string>();
  for (const mod of m.modules ?? []) {
    if (!mod.name) {
      issues.push({ level: "error", msg: "存在缺少 name 的 module" });
      continue;
    }
    if (modSeen.has(mod.name)) issues.push({ level: "error", msg: `module name 重复: ${mod.name}` });
    modSeen.add(mod.name);
    if (!mod.entry?.length)
      issues.push({ level: "warn", msg: `module ${mod.name} 未声明 entry（无法做新鲜度绑定）` });
  }
  return issues;
}
