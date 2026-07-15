import type { Manifest } from "./manifest";
import { planChecks, type Plan, type PlannedChange, type PlanOptions } from "./planner";
import { inspectValidationGateHealth } from "./validation-gates";

/** Add repository-aware, non-waivable gate health to the pure impact plan. */
export function planRepositoryChecks(
  repo: string,
  manifest: Manifest,
  changes: Array<string | PlannedChange>,
  options: PlanOptions = {},
): Plan {
  const plan = planChecks(manifest, changes, options);
  for (const issue of inspectValidationGateHealth(repo, manifest)) {
    plan.gaps.push({
      kind: "validation-gate-invalid",
      where: `gate:${issue.gate}`,
      why: issue.message,
      suggestion: "修正 validation gate 的 owns/tests/acceptance 边界并确保真实验收文件存在，然后重跑检查",
      severity: issue.level === "error" ? "blocking" : "advisory",
    });
  }
  return plan;
}
