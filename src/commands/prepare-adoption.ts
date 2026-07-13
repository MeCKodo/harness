import { resolve } from "node:path";
import { prepareAdoptionCandidate } from "../adoption";
import { ok } from "../util";

export interface PrepareAdoptionCommandOpts {
  output: string;
  json?: boolean;
}

export function prepareAdoptionCmd(repo: string, opts: PrepareAdoptionCommandOpts): number {
  if (!opts.output?.trim()) throw new Error("candidate output directory is required");
  const output = resolve(opts.output);
  const candidate = prepareAdoptionCandidate(repo, output);
  const result = {
    ok: true,
    schema: candidate.schema,
    candidateHash: candidate.candidateHash,
    output,
    assurance: candidate.assurance,
    independence: candidate.independence,
    legacyEvidenceCount: candidate.legacy.length,
    targetCount: candidate.targets.length,
  };
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n");
  else ok(`prepared adoption candidate ${candidate.candidateHash} at ${output}`);
  return 0;
}
