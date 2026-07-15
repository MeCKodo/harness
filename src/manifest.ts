import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";
import { isSafeContractId } from "./contracts";

export interface Capability {
  run: string;
  desc?: string;
  example?: string;
  background?: boolean;
  mutating?: boolean;
  bootstrap?: boolean; // keep this command in the short AGENTS.md bootstrap
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
  allow_empty?: boolean; // absence is intentional; suppress the zero-file doctor warning
}

export interface Invariant {
  id: string;
  rule: string;
  enforcement?: Enforcement;
  check?: string;
  manual?: boolean;
  llm_judge?: boolean;
}

export type KnowledgeRoot = "agents" | "repo";
export type KnowledgeAuthority = "derived" | "policy" | "review";

export interface Knowledge {
  path: string;
  role?: string;
  binds?: string[];
  root?: KnowledgeRoot; // default: agents; repo permits any repo-relative path
  authority?: KnowledgeAuthority; // omitted keeps legacy advisory freshness semantics
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
  gates?: string[]; // project-defined validation gates that cannot be bypassed by a profile
  playbook?: string; // ref into playbooks dir: how to verify changes to this module
  remediation?: string; // custom hint appended to gaps for this module
  test_touch?: TestTouchPolicy; // whether a production change must also touch a declared test
}

export interface ValidationGate {
  desc?: string;
  checks: string[]; // runnable capabilities that must execute whenever this gate is affected
  acceptance?: {
    tests: string[]; // acceptance-test globs, intentionally separate from module unit tests
    test_touch: TestTouchPolicy; // explicit: required/advisory/off; no hidden default
  };
}

/**
 * Impact-driven validation: which checks to run when a change lands, keyed by
 * the modules it touches. Deterministic (glob + declared capability), no LLM,
 * no domain taxonomy — projects author their own surfaces via modules[].
 */
export interface Validation {
  gates?: Record<string, ValidationGate>; // reusable project-defined proof obligations attached by modules[].gates
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
export const SUPPORTED_MANIFEST_SPECS = ["ai-harness/v0", "ai-harness/v1"] as const;
export const LATEST_MANIFEST_SPEC = "ai-harness/v1";
const MAX_GLOB_PATTERN_LENGTH = 4_096;

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

  function checkPositiveGlobs(value: unknown, prefix: string): void {
    if (!Array.isArray(value)) return;
    for (let i = 0; i < value.length; i++) {
      const glob = value[i];
      if (typeof glob === "string" && glob.startsWith("!")) {
        issues.push({
          level: "error",
          msg: `${prefix}[${i}] 不支持 ! 否定 glob（请使用正向 glob，并通过 owns/tests 等字段分离包含范围）`,
        });
      }
    }
  }

  function checkGlobSafety(value: unknown, prefix: string): void {
    if (!Array.isArray(value)) return;
    for (let index = 0; index < value.length; index++) {
      const glob = value[index];
      if (typeof glob !== "string") continue;
      if (glob.length > MAX_GLOB_PATTERN_LENGTH) {
        issues.push({
          level: "error",
          msg: `${prefix}[${index}] 过长（最大 ${MAX_GLOB_PATTERN_LENGTH} 个字符），无法安全编译`,
        });
        continue;
      }
      try {
        picomatch.makeRe(glob, { dot: true });
      } catch (error) {
        issues.push({ level: "error", msg: `${prefix}[${index}] 无法安全编译: ${(error as Error).message}` });
      }
    }
  }

  function checkRegexes(value: unknown, prefix: string): void {
    if (!Array.isArray(value)) return;
    for (let index = 0; index < value.length; index++) {
      if (typeof value[index] !== "string") continue;
      try {
        new RegExp(value[index] as string);
      } catch (error) {
        issues.push({ level: "error", msg: `${prefix}[${index}] 不是有效正则: ${(error as Error).message}` });
      }
    }
  }

  function checkRelativePath(value: unknown, prefix: string): void {
    if (typeof value !== "string") return;
    const components = value.split(/[\\/]/);
    if (!value || value.includes("\0") || isAbsolute(value) || components.includes(".."))
      issues.push({ level: "error", msg: `${prefix} 必须是声明根目录内的非空相对路径，不能越界: ${value}` });
  }

  function checkRelativePaths(value: unknown, prefix: string): void {
    if (!Array.isArray(value)) return;
    for (let index = 0; index < value.length; index++) checkRelativePath(value[index], `${prefix}[${index}]`);
  }

  if (!m.spec) issues.push({ level: "error", msg: "缺少 spec 字段" });
  else if (typeof m.spec !== "string") issues.push({ level: "error", msg: "spec 必须是字符串" });
  else if (!SUPPORTED_MANIFEST_SPECS.includes(m.spec as (typeof SUPPORTED_MANIFEST_SPECS)[number]))
    issues.push({ level: "error", msg: `不支持 manifest spec ${m.spec}；当前 CLI 支持 ${SUPPORTED_MANIFEST_SPECS.join(", ")}` });
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
    for (const flag of ["background", "mutating", "bootstrap"] as const)
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
      if (rawContract.id && !isSafeContractId(rawContract.id))
        issues.push({
          level: "error",
          msg: `contracts[${index}].id 必须是可移植文件名：1-128 位 ASCII 字母、数字、点、下划线或连字符，以字母或数字开头，且不能使用系统保留名`,
        });
      const portableKey = rawContract.id.toLowerCase();
      if (contractSeen.has(portableKey))
        issues.push({ level: "error", msg: `contract id 在大小写不敏感文件系统上重复: ${rawContract.id}` });
      contractSeen.add(portableKey);
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
    checkRegexes(inv.enforcement?.forbid_pattern, `${pfx}.forbid_pattern`);
    checkRegexes(inv.enforcement?.forbid_import, `${pfx}.forbid_import`);
    checkRegexes(inv.enforcement?.require_pattern, `${pfx}.require_pattern`);
    checkStrArr(inv.enforcement?.path_glob as unknown[] | undefined, `${pfx}.path_glob`);
    checkPositiveGlobs(inv.enforcement?.path_glob, `${pfx}.path_glob`);
    checkGlobSafety(inv.enforcement?.path_glob, `${pfx}.path_glob`);
    checkRelativePaths(inv.enforcement?.path_glob, `${pfx}.path_glob`);
    if (inv.enforcement?.allow_empty !== undefined && typeof inv.enforcement.allow_empty !== "boolean")
      issues.push({ level: "error", msg: `invariant ${label}.enforcement.allow_empty 必须是布尔值` });
  }

  // knowledge.binds
  const knowledgePaths = new Set<string>();
  for (const rawKnowledge of checkedList(m.knowledge, "knowledge")) {
    if (!isRecord(rawKnowledge)) {
      issues.push({ level: "error", msg: "knowledge 条目必须是对象" });
      continue;
    }
    const k = rawKnowledge as unknown as Knowledge;
    if (typeof k.path !== "string" || !k.path) issues.push({ level: "error", msg: "knowledge.path 必填且必须是字符串" });
    else {
      checkRelativePath(k.path, `knowledge "${k.path}" 的 path`);
      if (knowledgePaths.has(k.path)) issues.push({ level: "error", msg: `knowledge path 重复，record-context-review 无法消歧: ${k.path}` });
      knowledgePaths.add(k.path);
    }
    checkStrArr(k.binds as unknown[] | undefined, `knowledge "${k.path}" 的 binds`);
    checkRelativePaths(k.binds, `knowledge "${k.path}" 的 binds`);
    if (k.root !== undefined && !["agents", "repo"].includes(String(k.root)))
      issues.push({ level: "error", msg: `knowledge "${k.path}" 的 root 必须是 agents/repo` });
    if (k.authority !== undefined && !["derived", "policy", "review"].includes(String(k.authority)))
      issues.push({ level: "error", msg: `knowledge "${k.path}" 的 authority 必须是 derived/policy/review` });
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
    checkRelativePaths(r.read, `routing "${r.when}" 的 read`);
    checkRelativePaths(r.entry, `routing "${r.when}" 的 entry`);
    for (const v of Array.isArray(r.verify) ? r.verify : []) {
      if (typeof v !== "string") continue; // 上面已报错，跳过语义检查
      // a verify step is either a known capability verb or a raw command (has a space)
      if (!v.includes(" ") && !capVerbs.has(v))
        issues.push({ level: "warn", msg: `routing "${r.when}" 的 verify 引用了未声明的 capability: ${v}` });
    }
  }

  const validationRecord = isRecord(m.validation) ? m.validation : {};
  const declaredGates = isRecord(validationRecord.gates) ? validationRecord.gates : {};
  const usesValidationGates = Object.keys(declaredGates).length > 0 ||
    (Array.isArray(m.modules) && m.modules.some((module) => isRecord(module) && Array.isArray(module.gates) && module.gates.length > 0));
  if (m.spec === "ai-harness/v0" && usesValidationGates)
    issues.push({
      level: "error",
      msg: "validation.gates / modules[].gates 需要 spec: ai-harness/v1；v1 会让旧版 CLI fail closed，不能被静默当成 unit-only",
    });
  const gateIds = new Set(Object.keys(declaredGates));
  const referencedGates = new Set<string>();
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
    for (const field of ["entry", "upstream", "downstream", "must_know", "pitfalls", "owns", "tests", "checks", "gates"] as const) {
      checkStrArr(mod[field], `module "${mod.name}" 的 ${field}`);
    }
    checkRelativePaths(mod.entry, `module "${mod.name}" 的 entry`);
    checkRelativePaths(mod.owns, `module "${mod.name}" 的 owns`);
    checkRelativePaths(mod.tests, `module "${mod.name}" 的 tests`);
    checkPositiveGlobs(mod.owns, `module "${mod.name}" 的 owns`);
    checkPositiveGlobs(mod.tests, `module "${mod.name}" 的 tests`);
    checkGlobSafety(mod.owns, `module "${mod.name}" 的 owns`);
    checkGlobSafety(mod.tests, `module "${mod.name}" 的 tests`);
    for (const field of ["playbook", "remediation"] as const) {
      if (mod[field] !== undefined && typeof mod[field] !== "string")
        issues.push({ level: "error", msg: `module "${mod.name}" 的 ${field} 必须是字符串` });
    }
    if (mod.test_touch !== undefined && !["required", "advisory", "off"].includes(mod.test_touch))
      issues.push({ level: "error", msg: `module "${mod.name}" 的 test_touch 必须是 required/advisory/off` });
    if (Array.isArray(mod.gates) && mod.gates.length > 0 && !(mod.owns?.length ?? 0))
      issues.push({ level: "error", msg: `module "${mod.name}" 声明了 gates 但没有 owns；生产改动永远无法触发 gate` });
    for (const gate of Array.isArray(mod.gates) ? mod.gates : []) {
      if (typeof gate !== "string") continue;
      referencedGates.add(gate);
      if (!gateIds.has(gate))
        issues.push({ level: "error", msg: `module "${mod.name}" 引用的 validation gate ${gate} 未声明` });
    }
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
    const gates = v.gates;
    if (gates !== undefined && !isRecord(gates)) issues.push({ level: "error", msg: "validation.gates 必须是对象" });
    for (const [id, rawGate] of Object.entries(isRecord(gates) ? gates : {})) {
      if (!id.trim()) {
        issues.push({ level: "error", msg: "validation gate id 不能为空" });
        continue;
      }
      if (!isRecord(rawGate)) {
        issues.push({ level: "error", msg: `validation gate ${id} 必须是对象` });
        continue;
      }
      if (rawGate.desc !== undefined && typeof rawGate.desc !== "string")
        issues.push({ level: "error", msg: `validation gate ${id}.desc 必须是字符串` });
      const checks = rawGate.checks;
      if (!Array.isArray(checks) || checks.length === 0)
        issues.push({ level: "error", msg: `validation gate ${id}.checks 必须包含至少一个 capability` });
      else checkStrArr(checks, `validation gate ${id}.checks`);
      for (const check of Array.isArray(checks) ? checks : []) {
        if (typeof check !== "string") continue;
        if (!capVerbs.has(check))
          issues.push({ level: "error", msg: `validation gate ${id}.checks 引用了未声明的 capability: ${check}` });
        else {
          const cap = capabilities[check] as Capability | undefined;
          if (cap?.mutating || cap?.background)
            issues.push({ level: "error", msg: `validation gate ${id}.checks 引用了不可自动执行的 capability: ${check}` });
        }
      }
      const acceptance = rawGate.acceptance;
      if (acceptance !== undefined && !isRecord(acceptance)) {
        issues.push({ level: "error", msg: `validation gate ${id}.acceptance 必须是对象` });
      } else if (isRecord(acceptance)) {
        if (!Array.isArray(acceptance.tests) || acceptance.tests.length === 0)
          issues.push({ level: "error", msg: `validation gate ${id}.acceptance.tests 必须包含至少一个 glob` });
        else checkStrArr(acceptance.tests, `validation gate ${id} 的 acceptance.tests`);
        checkPositiveGlobs(acceptance.tests, `validation gate ${id} 的 acceptance.tests`);
        checkGlobSafety(acceptance.tests, `validation gate ${id} 的 acceptance.tests`);
        checkRelativePaths(acceptance.tests, `validation gate ${id} 的 acceptance.tests`);
        if (!["required", "advisory", "off"].includes(String(acceptance.test_touch)))
          issues.push({ level: "error", msg: `validation gate ${id}.acceptance.test_touch 必须是 required/advisory/off` });
      }
      if (!referencedGates.has(id)) {
        issues.push({ level: "error", msg: `validation gate ${id} 未被任何 module.gates 引用，生产改动不会触发它` });
      }
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
    checkPositiveGlobs(v.required_coverage, "validation.required_coverage");
    checkGlobSafety(v.required_coverage, "validation.required_coverage");
    checkRelativePaths(v.required_coverage, "validation.required_coverage");
    if (v.policies !== undefined && !isRecord(v.policies))
      issues.push({ level: "error", msg: "validation.policies 必须是对象" });
    const defaultTouch = isRecord(v.policies) ? v.policies.test_touch_default : undefined;
    if (defaultTouch !== undefined && !["required", "advisory", "off"].includes(String(defaultTouch)))
      issues.push({ level: "error", msg: "validation.policies.test_touch_default 必须是 required/advisory/off" });
  }
  if (m.playbooks !== undefined && !isRecord(m.playbooks)) issues.push({ level: "error", msg: "playbooks 必须是对象" });
  else if (m.playbooks?.dir !== undefined && typeof m.playbooks.dir !== "string")
    issues.push({ level: "error", msg: "playbooks.dir 必须是字符串" });
  else checkRelativePath(m.playbooks?.dir, "playbooks.dir");
  return issues;
}
