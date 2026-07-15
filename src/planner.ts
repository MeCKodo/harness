import picomatch from "picomatch";
import type { Manifest, Module } from "./manifest";
import { sha256 } from "./util";

// Impact-driven check planner. PURE: given a manifest + the list of changed
// files, it computes which declared checks to run and where the honest gaps are.
// No git, no filesystem, no process, no LLM — just glob matching. This is what
// makes the loop's verdict deterministic and unit-testable.

export type GapKind =
  | "no-impact-map" // manifest declares no module with `owns` — cannot plan by impact
  | "unmapped-file" // a changed file belongs to no module.owns
  | "module-without-tests" // an affected module declares no `tests` glob
  | "missing-test-touch" // module prod changed but none of its test files were touched
  | "no-checks-selected" // there were changes, but no check resolved to run
  | "diff-unavailable"
  | "manifest-invalid"
  | "selected-check-not-run"
  | "validation-gate-invalid"
  | "unmapped-required-file"
  | "unknown-profile"
  | "manual-base-required"
  | "propagation-note"; // static globs do not analyze cross-module dependencies

export type Severity = "blocking" | "advisory";

export interface Gap {
  kind: GapKind;
  where: string; // module name, file list, or "" when global
  why: string;
  suggestion: string; // deterministic next-step for the agent to act on
  severity: Severity;
}

export interface PlanNote {
  kind: "propagation-note";
  message: string;
  suggestion: string;
}

export interface SelectedCheck {
  id: string; // capability verb
  reason: string; // why it was selected (module:<name> | profile:<id> | always | no_match)
}

export interface Plan {
  changed: string[];
  affected: string[]; // names of modules whose `owns` matched a changed file
  gates: string[]; // project-defined validation gates activated by affected modules/tests
  checks: SelectedCheck[];
  gaps: Gap[];
  notes: PlanNote[];
  profile: string | null;
}

export interface PlanOptions {
  profile?: string; // use validation.checksets[profile] instead of per-module checks
}

export function validationPlanFingerprint(plan: Plan): string {
  return sha256(
    JSON.stringify({
      version: 1,
      profile: plan.profile,
      changed: plan.changed,
      affected: plan.affected,
      gates: plan.gates,
      checks: plan.checks,
      gaps: plan.gaps,
      notes: plan.notes,
    }),
  );
}

export interface PlannedChange {
  path: string;
  status: string;
  layer?: "index" | "worktree" | "untracked";
}

/** True if any glob in `globs` matches `file`. Empty globs never match. */
function matchesAny(file: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return picomatch(globs, { dot: true })(file);
}

function suggestionFor(mod: Module, base: string): string {
  return mod.remediation ? mod.remediation : base;
}

export function planChecks(m: Manifest, input: Array<string | PlannedChange>, opts: PlanOptions = {}): Plan {
  const changeEntries = input.map((change) => (typeof change === "string" ? { path: change, status: "M" } : change));
  const changed = [...new Set(changeEntries.map((change) => change.path))];
  const finalStatus = new Map<string, { priority: number; status: string }>();
  const layerPriority = { index: 1, worktree: 2, untracked: 3 } as const;
  for (const change of changeEntries) {
    const priority = change.layer ? layerPriority[change.layer] : 4;
    const previous = finalStatus.get(change.path);
    if (!previous || priority >= previous.priority) finalStatus.set(change.path, { priority, status: change.status });
  }
  const modules = m.modules ?? [];
  const compiled = modules.map((mod) => ({
    mod,
    owns: mod.owns?.length ? picomatch(mod.owns, { dot: true }) : null,
    tests: mod.tests?.length ? picomatch(mod.tests, { dot: true }) : null,
  }));
  const modulesWithOwns = compiled.filter((item) => item.owns !== null);
  const gateDefs = m.validation?.gates ?? {};
  const compiledGates = Object.entries(gateDefs)
    .map(([id, gate]) => ({
      id,
      gate,
      acceptance: gate.acceptance?.tests?.length ? picomatch(gate.acceptance.tests, { dot: true }) : null,
      overlapsModuleBoundary: picomatch(
        modules.filter((mod) => mod.gates?.includes(id)).flatMap((mod) => [...(mod.owns ?? []), ...(mod.tests ?? [])]),
        { dot: true },
      ),
    }));
  const gaps: Gap[] = [];
  const notes: PlanNote[] = [];

  // Which modules own at least one changed file, and which files matched anything.
  const affectedModules: Module[] = [];
  const productionAffected = new Set<string>();
  const affectedGateSet = new Set<string>();
  const productionAffectedGates = new Set<string>();
  const matchedFiles = new Set<string>();
  for (const item of compiled) {
    const { mod } = item;
    let productionHit = false;
    let testHit = false;
    for (const f of changed) {
      if (item.owns?.(f)) {
        productionHit = true;
        matchedFiles.add(f);
      }
      if (item.tests?.(f)) {
        testHit = true;
        matchedFiles.add(f);
      }
    }
    if (productionHit || testHit) affectedModules.push(mod);
    if (productionHit) productionAffected.add(mod.name);
  }
  for (const mod of affectedModules) {
    for (const gate of mod.gates ?? []) affectedGateSet.add(gate);
    if (productionAffected.has(mod.name)) for (const gate of mod.gates ?? []) productionAffectedGates.add(gate);
  }
  for (const item of compiledGates) {
    if (!item.acceptance) continue;
    for (const file of changed) {
      if (!item.acceptance(file)) continue;
      matchedFiles.add(file);
      affectedGateSet.add(item.id);
    }
  }
  const affectedGates = compiledGates.filter((item) => affectedGateSet.has(item.id));
  const unmapped = changed.filter((f) => !matchedFiles.has(f));
  const requiredCoverage = m.validation?.required_coverage?.length
    ? picomatch(m.validation.required_coverage, { dot: true })
    : null;
  const requiredUnmapped = requiredCoverage ? unmapped.filter((file) => requiredCoverage(file)) : [];
  const advisoryUnmapped = unmapped.filter((file) => !requiredUnmapped.includes(file));

  // ── resolve checks (dedupe, keep first reason) ──────────────────────────
  const checks: SelectedCheck[] = [];
  const seen = new Set<string>();
  const add = (id: string, reason: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    checks.push({ id, reason });
  };

  const profile = opts.profile ?? null;
  if (profile) {
    const set = m.validation?.checksets?.[profile];
    if (!set) {
      gaps.push({
        kind: "unknown-profile",
        where: profile,
        why: `validation.checksets 没有声明 profile: ${profile}`,
        suggestion: "检查 --profile 拼写，或先在 validation.checksets 中声明它",
        severity: "blocking",
      });
    } else {
      for (const c of set.checks ?? []) add(c, `profile:${profile}`);
    }
  } else {
    for (const mod of affectedModules) for (const c of mod.checks ?? []) add(c, `module:${mod.name}`);
    if (affectedModules.length === 0)
      for (const c of m.validation?.defaults?.no_match ?? []) add(c, "no_match");
  }
  // Gates are mandatory proof obligations. Profiles may replace ordinary module
  // checks, but can never bypass a gate attached to an affected module/test.
  for (const item of affectedGates) for (const check of item.gate.checks ?? []) add(check, `gate:${item.id}`);
  for (const c of m.validation?.defaults?.always ?? []) add(c, "always");

  // ── gaps ────────────────────────────────────────────────────────────────
  if (modulesWithOwns.length === 0) {
    gaps.push({
      kind: "no-impact-map",
      where: "modules",
      why: "manifest 没有任何声明 owns 的模块，无法按影响面选测",
      suggestion: "在 .agents/manifest.yaml 的 modules[] 补 owns/tests/checks，让改动能映射到验证",
      severity: "advisory",
    });
  }

  for (const mod of affectedModules) {
    if (!productionAffected.has(mod.name)) continue;
    const testTouch = mod.test_touch ?? m.validation?.policies?.test_touch_default ?? "advisory";
    if (!(mod.tests?.length ?? 0)) {
      if (testTouch === "off") continue;
      gaps.push({
        kind: "module-without-tests",
        where: mod.name,
        why: `模块 ${mod.name} 未声明 tests，无回归网、也无法判断测试是否被补`,
        suggestion: suggestionFor(
          mod,
          `给模块 ${mod.name} 声明 tests glob 并补测试${mod.playbook ? `；参考 playbook ${mod.playbook}` : ""}`,
        ),
        severity: testTouch === "required" ? "blocking" : "advisory",
      });
      continue;
    }
    const testTouched = changed.some((path) => finalStatus.get(path)?.status !== "D" && matchesAny(path, mod.tests));
    if (!testTouched && testTouch !== "off") {
      gaps.push({
        kind: "missing-test-touch",
        where: mod.name,
        why: `改了 ${mod.name} 的生产代码，但它的测试(${mod.tests!.join(", ")})一个都没动`,
        suggestion: suggestionFor(
          mod,
          `在 ${mod.tests!.join(" / ")} 补覆盖本次改动的用例${mod.playbook ? `（参考 playbook ${mod.playbook}）` : ""}，或 --waive missing-test-touch --where ${mod.name} --reason <理由>`,
        ),
        severity: testTouch === "required" ? "blocking" : "advisory",
      });
    }
  }

  for (const item of affectedGates) {
    if (!productionAffectedGates.has(item.id) || !item.gate.acceptance) continue;
    const policy = item.gate.acceptance.test_touch;
    if (policy === "off") continue;
    const testTouched = changed.some(
      (path) =>
        finalStatus.get(path)?.status !== "D" &&
        matchesAny(path, item.gate.acceptance!.tests) &&
        !item.overlapsModuleBoundary(path),
    );
    if (!testTouched) {
      gaps.push({
        kind: "missing-test-touch",
        where: `gate:${item.id}`,
        why: `生产代码触发了 validation gate ${item.id}，但它的 acceptance tests(${item.gate.acceptance.tests.join(", ")})一个都没动`,
        suggestion: `在 ${item.gate.acceptance.tests.join(" / ")} 补覆盖本次用户可观察行为的验收用例，或 --waive missing-test-touch --where gate:${item.id} --reason <理由>`,
        severity: policy === "required" ? "blocking" : "advisory",
      });
    }
  }

  if (requiredUnmapped.length) {
    const shown = requiredUnmapped.slice(0, 8).join(", ");
    gaps.push({
      kind: "unmapped-required-file",
      where: shown + (requiredUnmapped.length > 8 ? ` …(+${requiredUnmapped.length - 8})` : ""),
      why: "这些改动位于 validation.required_coverage，但不属于任何模块的 owns/tests",
      suggestion: "把文件加入已有模块的 owns/tests，或新增模块卡；必需覆盖范围不能静默跳过",
      severity: "blocking",
    });
  }

  if (advisoryUnmapped.length) {
    const shown = advisoryUnmapped.slice(0, 8).join(", ");
    gaps.push({
      kind: "unmapped-file",
      where: shown + (advisoryUnmapped.length > 8 ? ` …(+${advisoryUnmapped.length - 8})` : ""),
      why: "这些改动文件不属于任何模块的 owns，未纳入影响面",
      suggestion: "若属于已有模块，补其 owns；若是新模块，在 modules[] 声明 owns/tests/checks",
      severity: "advisory",
    });
  }

  if (changed.length > 0 && checks.length === 0 && !gaps.some((gap) => gap.kind === "unknown-profile")) {
    gaps.push({
      kind: "no-checks-selected",
      where: "validation",
      why: "有改动，但没有解析出任何要跑的 check（命中模块无 checks，或 profile/defaults 为空）",
      suggestion: "给命中的模块声明 checks，或配置 validation.defaults.no_match / profile checkset",
      severity: "blocking",
    });
  }

  if (affectedModules.length > 0) {
    notes.push({
      kind: "propagation-note",
      message: "影响面按静态 glob 计算，不分析跨模块依赖；下游模块可能未被选中",
      suggestion: "若本次改的是共享/底层代码，手动确认依赖它的模块的测试",
    });
  }

  return {
    changed,
    affected: affectedModules.map((x) => x.name),
    gates: affectedGates.map((item) => item.id),
    checks,
    gaps,
    notes,
    profile,
  };
}
