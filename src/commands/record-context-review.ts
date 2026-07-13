import { loadManifest, validateManifest } from "../manifest";
import { recordContextReview } from "../state";
import { ok } from "../util";

export interface RecordContextReviewCommandOpts {
  path?: string;
  module?: string;
  reason: string;
  session?: string;
  json?: boolean;
}

export function recordContextReviewCmd(repo: string, opts: RecordContextReviewCommandOpts): number {
  const manifest = loadManifest(repo);
  const errors = validateManifest(manifest).filter((issue) => issue.level === "error");
  if (errors.length) throw new Error(`manifest invalid: ${errors.map((issue) => issue.msg).join("; ")}`);
  const record = recordContextReview(repo, manifest, opts);
  if (opts.json) process.stdout.write(JSON.stringify({ ok: true, review: record }) + "\n");
  else ok(`recorded context review: ${record.key} — ${record.reason}`);
  return 0;
}
