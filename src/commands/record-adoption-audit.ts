import { resolve } from "node:path";
import { recordAdoptionAudit } from "../adoption";
import { ok } from "../util";

export interface RecordAdoptionAuditCommandOpts {
  candidate: string;
  verdict: "pass" | "fail";
  reason: string;
  report: string;
  receipt?: string;
  json?: boolean;
}

export function recordAdoptionAuditCmd(repo: string, opts: RecordAdoptionAuditCommandOpts): number {
  if (!opts.candidate?.trim()) throw new Error("candidate directory is required");
  if (!opts.report?.trim()) throw new Error("audit report path is required");
  const recorded = recordAdoptionAudit(repo, resolve(opts.candidate), {
    verdict: opts.verdict,
    reason: opts.reason,
    reportPath: resolve(opts.report),
    receiptPath: opts.receipt ? resolve(opts.receipt) : undefined,
  });
  const result = {
    ok: true,
    schema: recorded.receipt.schema,
    candidateHash: recorded.receipt.candidateHash,
    verdict: recorded.receipt.verdict,
    receipt: recorded.receiptPath,
    assurance: recorded.receipt.assurance,
    independence: recorded.receipt.independence,
  };
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n");
  else ok(`recorded ${recorded.receipt.verdict} adoption audit for ${recorded.receipt.candidateHash} at ${recorded.receiptPath}`);
  return 0;
}
