import { collectChanges, GitDiffError } from "../git";
import { loadManifest, validateManifest } from "../manifest";
import { planChecks } from "../planner";
import { err, info, ok, warn } from "../util";

export interface PlanChecksOpts {
  base?: string;
  json?: boolean;
  profile?: string;
}

// plan-checks: compute which checks THIS change should run, and the honest gaps.
// Deterministic, executes NOTHING. Invalid manifests/diffs fail closed.
export function planChecksCmd(repo: string, opts: PlanChecksOpts): number {
  const base = opts.base ?? "HEAD";
  const errors: string[] = [];
  let m;
  try {
    m = loadManifest(repo);
  } catch (error) {
    errors.push(`manifest-invalid: ${(error as Error).message}`);
  }
  if (m) errors.push(...validateManifest(m).filter((issue) => issue.level === "error").map((issue) => `manifest-invalid: ${issue.msg}`));

  let changes;
  try {
    changes = collectChanges(repo, base);
  } catch (error) {
    const kind = error instanceof GitDiffError ? error.kind : "diff-failed";
    errors.push(`${kind}: ${(error as Error).message}`);
  }

  const plan = m && changes && !errors.length ? planChecks(m, changes.entries, { profile: opts.profile }) : null;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: "ai-harness/plan-checks/v1",
          requestedBase: base,
          resolvedBase: changes?.resolvedBase ?? null,
          fingerprint: changes?.fingerprint ?? "",
          ...(plan ?? { changed: changes?.files ?? [], affected: [], checks: [], gaps: [], notes: [], profile: opts.profile ?? null }),
          errors,
        },
        null,
        2,
      ) + "\n",
    );
    return errors.length ? 1 : 0;
  }

  if (!plan || !changes) {
    for (const message of errors) err(message);
    info("plan-checks: FAILED (unable to produce a trustworthy plan)");
    return 1;
  }

  info(`plan-checks (base ${base} -> ${changes.resolvedBase ?? "empty tree"}) — ${changes.files.length} changed file(s)`);
  info(plan.affected.length ? `affected modules: ${plan.affected.join(", ")}` : "affected modules: (none)");

  info("\nchecks to run:");
  if (!plan.checks.length) info("  (none)");
  for (const c of plan.checks) ok(`${c.id}  [${c.reason}]`);

  info("\ngaps:");
  if (!plan.gaps.length) ok("no gaps");
  for (const g of plan.gaps) {
    const tag = g.severity === "blocking" ? "BLOCKING" : "advisory";
    warn(`[${g.kind}/${tag}] ${g.where ? g.where + " — " : ""}${g.why}`);
    info(`       -> ${g.suggestion}`);
  }
  if (plan.notes.length) info("\nnotes:");
  for (const note of plan.notes) info(`  NOTE ${note.message}\n       -> ${note.suggestion}`);
  return 0;
}
