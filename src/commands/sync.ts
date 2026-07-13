import { assertManagedFileAdoption, assertManagedFileAdoptionReceipt } from "../adoption";
import { loadManifest, validateManifest } from "../manifest";
import { writeManagedFiles } from "../managed-files";
import { renderTargets } from "../render";
import { info, ok } from "../util";

export interface SyncOpts {
  adoptExisting?: boolean;
  adoptionCandidate?: string;
  adoptionAudit?: string;
}

export function syncCmd(repo: string, opts: SyncOpts = {}): void {
  const m = loadManifest(repo);
  const errors = validateManifest(m).filter((issue) => issue.level === "error");
  if (errors.length) throw new Error(`manifest invalid: ${errors.map((issue) => issue.msg).join("; ")}`);
  info("Syncing generated files from .agents/manifest.yaml ...");
  const targets = renderTargets(m);
  if (!!opts.adoptionCandidate !== !!opts.adoptionAudit)
    throw new Error("adoption requires both --candidate <bundle> and --audit <receipt>");
  if ((opts.adoptionCandidate || opts.adoptionAudit) && !opts.adoptExisting)
    throw new Error("--candidate/--audit are only valid with --adopt-existing");
  const result = writeManagedFiles(repo, targets, {
    authorize: (inspections) => {
      if (opts.adoptExisting && opts.adoptionCandidate && opts.adoptionAudit) {
        assertManagedFileAdoptionReceipt(repo, inspections, opts.adoptionCandidate, opts.adoptionAudit);
        return;
      }
      // This also permits compatibility no-ops when every target is already
      // managed/current, but an actual first takeover cannot pass without the
      // content-bound candidate + audit receipt pair above.
      assertManagedFileAdoption(repo, inspections, false);
    },
  });
  const preservedAliases = new Set(result.preservedAliases);
  const written = new Set(result.written);
  for (const [rel] of targets) {
    if (preservedAliases.has(rel)) ok(`preserved ${rel} -> AGENTS.md`);
    else if (written.has(rel)) ok(`wrote ${rel}`);
    else ok(`${rel} already current`);
  }
  info("Context review evidence was not changed; use `record-context-review` only after an Agent reviews the context.");
}
