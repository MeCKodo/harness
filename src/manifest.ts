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

export type TestTouchPolicy = "required" | "advisory" | "off";

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
  owns?: string[]; // production-file globs owned by this module (used to match a diff)
  tests?: string[]; // test-file globs covering this module (used to detect a test touch)
  checks?: string[]; // capability verbs to run when this module changes (executed by run-checks)
  playbook?: string; // ref into playbooks dir: how to verify changes to this module
  remediation?: string; // custom hint appended to gaps for this module
  test_touch?: TestTouchPolicy; // whether a production change must also touch a declared test
}

/**
 * Impact-driven validation: which checks to run when a change lands, keyed by
 * the modules it touches. Deterministic (glob + declared capability), no LLM,
 * no domain taxonomy — projects author their own surfaces via modules[].
 */
export interface Validation {
  checksets?: Record<string, { checks: string[] }>; // named, reusable check groups (ids are free-form)
  defaults?: {
    no_match?: string[]; // checks to run when a change matches no module.owns
    always?: string[]; // checks always added regardless of what changed
  };
  policies?: {
    test_touch_default?: TestTouchPolicy;
  };
  required_coverage?: string[]; // changed files matching these globs must belong to owns/tests
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
  validation?: Validation;
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
  const parsed: unknown = YAML.parse(readFileSync(p, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${MANIFEST_REL} 根节点必须是对象`);
  return parsed as Manifest;
}

export interface ValidationIssue {
  level: "error" | "warn";
  msg: string;
}

export function validateManifest(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!m || typeof m !== "object" || Array.isArray(m)) {
    return [{ level: "error", msg: "manifest 根节点必须是对象" }];
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  function checkedList(value: unknown, prefix: string): unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      issues.push({ level: "error", msg: `${prefix} 必须是数组（当前是 ${typeof value}）` });
      return [];
    }
    return value;
  }

  /** 检查值是字符串数组，否则报错。prefix 用于错误信息。 */
  function checkStrArr(arr: unknown, prefix: string): void {
    if (arr === undefined || arr === null) return;
    if (!Array.isArray(arr)) {
      issues.push({ level: "error", msg: `${prefix} 必须是数组（当前是 ${typeof arr}）` });
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== "string") {
        issues.push({
          level: "error",
          msg: `${prefix}[${i}] 必须是字符串（当前是 ${typeof arr[i]}）`,
        });
      }
    }
  }

  if (!m.spec) issues.push({ level: "error", msg: "缺少 spec 字段" });
  else if (typeof m.spec !== "string") issues.push({ level: "error", msg: "spec 必须是字符串" });
  if (!m.identity || !isRecord(m.identity)) issues.push({ level: "error", msg: "identity 必须是对象" });
  if (!m.identity?.name) issues.push({ level: "error", msg: "identity.name 必填" });
  else if (typeof m.identity.name !== "string") issues.push({ level: "error", msg: "identity.name 必须是字符串" });
  if (!m.identity?.summary) issues.push({ level: "warn", msg: "identity.summary 建议填写" });
  else if (typeof m.identity.summary !== "string") issues.push({ level: "error", msg: "identity.summary 必须是字符串" });

  // identity 下的字符串数组
  checkStrArr(m.identity?.scope_in as unknown[] | undefined, "identity.scope_in");
  checkStrArr(m.identity?.scope_out as unknown[] | undefined, "identity.scope_out");
  checkStrArr(m.identity?.upstream as unknown[] | undefined, "identity.upstream");
  checkStrArr(m.identity?.downstream as unknown[] | undefined, "identity.downstream");

  const capabilities = isRecord(m.capabilities) ? m.capabilities : {};
  if (m.capabilities !== undefined && !isRecord(m.capabilities))
    issues.push({ level: "error", msg: "capabilities 必须是对象" });
  for (const [verb, rawCap] of Object.entries(capabilities)) {
    const cap = rawCap as Capability;
    if (!isRecord(rawCap) || typeof cap.run !== "string" || !cap.run.trim())
      issues.push({ level: "error", msg: `capabilities.${verb}.run 必填且必须是字符串` });
    for (const flag of ["background", "mutating"] as const)
      if (isRecord(rawCap) && cap[flag] !== undefined && typeof cap[flag] !== "boolean")
        issues.push({ level: "error", msg: `capabilities.${verb}.${flag} 必须是布尔值` });
  }

  for (const [index, rawEnv] of checkedList(m.environment, "environment").entries()) {
    if (!isRecord(rawEnv)) {
      issues.push({ level: "error", msg: `environment[${index}] 必须是对象` });
      continue;
    }
    if (typeof rawEnv.name !== "string" || !rawEnv.name) issues.push({ level: "error", msg: `environment[${index}].name 必填` });
    for (const flag of ["required", "secret"])
      if (rawEnv[flag] !== undefined && typeof rawEnv[flag] !== "boolean")
        issues.push({ level: "error", msg: `environment[${index}].${flag} 必须是布尔值` });
  }

  const contractSeen = new Set<string>();
  for (const [index, rawContract] of checkedList(m.contracts, "contracts").entries()) {
    if (!isRecord(rawContract)) {
      issues.push({ level: "error", msg: `contracts[${index}] 必须是对象` });
      continue;
    }
    for (const field of ["id", "kind", "desc"])
      if (typeof rawContract[field] !== "string" || !rawContract[field])
        issues.push({ level: "error", msg: `contracts[${index}].${field} 必填且必须是字符串` });
    if (typeof rawContract.id === "string") {
      if (contractSeen.has(rawContract.id)) issues.push({ level: "error", msg: `contract id 重复: ${rawContract.id}` });
      contractSeen.add(rawContract.id);
    }
    for (const field of ["check", "snapshot", "manual_verify"])
      if (rawContract[field] !== undefined && typeof rawContract[field] !== "string")
        issues.push({ level: "error", msg: `contracts[${index}].${field} 必须是字符串` });
  }

  const seen = new Set<string>();
  for (const [index, rawInv] of checkedList(m.invariants, "invariants").entries()) {
    if (!isRecord(rawInv)) {
      issues.push({ level: "error", msg: "invariants 条目必须是对象" });
      continue;
    }
    const inv = rawInv as unknown as Invariant;
    const validId = typeof inv.id === "string" && inv.id.trim().length > 0;
    const label = validId ? inv.id : `[${index}]`;
    if (!validId) issues.push({ level: "error", msg: `invariants[${index}].id 必填且必须是字符串` });
    else {
      if (seen.has(inv.id)) issues.push({ level: "error", msg: `invariant id 重复: ${inv.id}` });
      seen.add(inv.id);
    }
    if (typeof inv.rule !== "string" || !inv.rule) issues.push({ level: "error", msg: `invariant ${label}.rule 必填` });
    for (const flag of ["manual", "llm_judge"] as const)
      if (inv[flag] !== undefined && typeof inv[flag] !== "boolean")
        issues.push({ level: "error", msg: `invariant ${label}.${flag} 必须是布尔值` });
    if (inv.check !== undefined && (typeof inv.check !== "string" || !inv.check.trim()))
      issues.push({ level: "error", msg: `invariant ${label}.check 必须是非空字符串` });
    if (inv.enforcement !== undefined && !isRecord(inv.enforcement))
      issues.push({ level: "error", msg: `invariant ${label}.enforcement 必须是对象` });
    if (inv.manual === true && (inv.enforcement !== undefined || inv.check !== undefined))
      issues.push({ level: "error", msg: `invariant ${label} 不能同时声明 manual:true 和 enforcement/check` });
    if (!inv.enforcement && !inv.check && !inv.manual) {
      issues.push({ level: "warn", msg: `invariant ${label} 既无 enforcement/check 也未标 manual` });
    }
    // enforcement 下的字符串数组
    const pfx = `invariant "${label}" 的 enforcement`;
    checkStrArr(inv.enforcement?.forbid_pattern as unknown[] | undefined, `${pfx}.forbid_pattern`);
    checkStrArr(inv.enforcement?.forbid_import as unknown[] | undefined, `${pfx}.forbid_import`);
    checkStrArr(inv.enforcement?.require_pattern as unknown[] | undefined, `${pfx}.require_pattern`);
    checkStrArr(inv.enforcement?.path_glob as unknown[] | undefined, `${pfx}.path_glob`);
  }

  // knowledge.binds
  for (const rawKnowledge of checkedList(m.knowledge, "knowledge")) {
    if (!isRecord(rawKnowledge)) {
      issues.push({ level: "error", msg: "knowledge 条目必须是对象" });
      continue;
    }
    const k = rawKnowledge as unknown as Knowledge;
    if (typeof k.path !== "string" || !k.path) issues.push({ level: "error", msg: "knowledge.path 必填且必须是字符串" });
    checkStrArr(k.binds as unknown[] | undefined, `knowledge "${k.path}" 的 binds`);
  }

  const capVerbs = new Set(Object.keys(capabilities));
  for (const rawRoute of checkedList(m.routing, "routing")) {
    if (!isRecord(rawRoute)) {
      issues.push({ level: "error", msg: "routing 条目必须是对象" });
      continue;
    }
    const r = rawRoute as unknown as Route;
    if (typeof r.when !== "string" || !r.when) issues.push({ level: "error", msg: "存在缺少 when 的 routing 条目" });
    for (const field of ["read", "entry", "dont_assume", "verify"] as const) {
      checkStrArr(r[field] as unknown[] | undefined, `routing "${r.when}" 的 ${field}`);
    }
    for (const v of Array.isArray(r.verify) ? r.verify : []) {
      if (typeof v !== "string") continue; // 上面已报错，跳过语义检查
      // a verify step is either a known capability verb or a raw command (has a space)
      if (!v.includes(" ") && !capVerbs.has(v))
        issues.push({ level: "warn", msg: `routing "${r.when}" 的 verify 引用了未声明的 capability: ${v}` });
    }
  }

  const modSeen = new Set<string>();
  for (const rawModule of checkedList(m.modules, "modules")) {
    if (!isRecord(rawModule)) {
      issues.push({ level: "error", msg: "modules 条目必须是对象" });
      continue;
    }
    const mod = rawModule as unknown as Module;
    if (typeof mod.name !== "string" || !mod.name.trim()) {
      issues.push({ level: "error", msg: "module.name 必填且必须是字符串" });
      continue;
    }
    if (modSeen.has(mod.name)) issues.push({ level: "error", msg: `module name 重复: ${mod.name}` });
    modSeen.add(mod.name);
    if (typeof mod.role !== "string" || !mod.role) issues.push({ level: "error", msg: `module ${mod.name}.role 必填` });
    if (!mod.entry?.length)
      issues.push({ level: "warn", msg: `module ${mod.name} 未声明 entry（无法做新鲜度绑定）` });
    for (const field of ["entry", "upstream", "downstream", "must_know", "pitfalls", "owns", "tests", "checks"] as const) {
      checkStrArr(mod[field], `module "${mod.name}" 的 ${field}`);
    }
    for (const field of ["playbook", "remediation"] as const) {
      if (mod[field] !== undefined && typeof mod[field] !== "string")
        issues.push({ level: "error", msg: `module "${mod.name}" 的 ${field} 必须是字符串` });
    }
    if (mod.test_touch !== undefined && !["required", "advisory", "off"].includes(mod.test_touch))
      issues.push({ level: "error", msg: `module "${mod.name}" 的 test_touch 必须是 required/advisory/off` });
    // module.checks are EXECUTED by run-checks, so each must be a declared capability
    // (no raw commands here — those stay in routing.verify prose).
    for (const c of Array.isArray(mod.checks) ? mod.checks : []) {
      if (typeof c === "string" && !capVerbs.has(c))
        issues.push({ level: "error", msg: `module "${mod.name}" 的 checks 引用了未声明的 capability: ${c}（checks 只能是 capability 动词）` });
      else if (typeof c === "string") {
        const cap = capabilities[c] as Capability | undefined;
        if (cap?.mutating || cap?.background)
          issues.push({
            level: "error",
            msg: `module "${mod.name}" 的 checks 引用了不可自动执行的 capability: ${c}（${cap.mutating ? "mutating" : "background"}）`,
          });
      }
    }
  }

  // validation: impact-driven checksets + defaults. All check refs must be declared capabilities.
  const v = m.validation;
  if (v) {
    if (!isRecord(v)) {
      issues.push({ level: "error", msg: "validation 必须是对象" });
      return issues;
    }
    const checksets = v.checksets;
    if (checksets !== undefined && !isRecord(checksets))
      issues.push({ level: "error", msg: "validation.checksets 必须是对象" });
    for (const [id, rawSet] of Object.entries(isRecord(checksets) ? checksets : {})) {
      if (!isRecord(rawSet)) {
        issues.push({ level: "error", msg: `validation.checksets.${id} 必须是对象` });
        continue;
      }
      const checks = rawSet.checks;
      if (checks === undefined || checks === null)
        issues.push({ level: "error", msg: `validation.checksets.${id}.checks 必填且必须是数组` });
      else checkStrArr(checks, `validation.checksets.${id}.checks`);
      for (const c of Array.isArray(checks) ? checks : []) {
        if (typeof c === "string" && !capVerbs.has(c))
          issues.push({ level: "error", msg: `validation.checksets.${id} 引用了未声明的 capability: ${c}` });
        else if (typeof c === "string") {
          const cap = capabilities[c] as Capability | undefined;
          if (cap?.mutating || cap?.background)
            issues.push({ level: "error", msg: `validation.checksets.${id} 引用了不可自动执行的 capability: ${c}` });
        }
      }
    }
    if (v.defaults !== undefined && !isRecord(v.defaults))
      issues.push({ level: "error", msg: "validation.defaults 必须是对象" });
    for (const key of ["no_match", "always"] as const) {
      const arr = isRecord(v.defaults) ? v.defaults[key] : undefined;
      checkStrArr(arr, `validation.defaults.${key}`);
      for (const c of Array.isArray(arr) ? arr : []) {
        if (typeof c === "string" && !capVerbs.has(c))
          issues.push({ level: "error", msg: `validation.defaults.${key} 引用了未声明的 capability: ${c}` });
        else if (typeof c === "string") {
          const cap = capabilities[c] as Capability | undefined;
          if (cap?.mutating || cap?.background)
            issues.push({ level: "error", msg: `validation.defaults.${key} 引用了不可自动执行的 capability: ${c}` });
        }
      }
    }
    checkStrArr(v.required_coverage, "validation.required_coverage");
    if (v.policies !== undefined && !isRecord(v.policies))
      issues.push({ level: "error", msg: "validation.policies 必须是对象" });
    const defaultTouch = isRecord(v.policies) ? v.policies.test_touch_default : undefined;
    if (defaultTouch !== undefined && !["required", "advisory", "off"].includes(String(defaultTouch)))
      issues.push({ level: "error", msg: "validation.policies.test_touch_default 必须是 required/advisory/off" });
  }
  if (m.playbooks !== undefined && !isRecord(m.playbooks)) issues.push({ level: "error", msg: "playbooks 必须是对象" });
  else if (m.playbooks?.dir !== undefined && typeof m.playbooks.dir !== "string")
    issues.push({ level: "error", msg: "playbooks.dir 必须是字符串" });
  return issues;
}
