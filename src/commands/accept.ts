import { readBaseline, runCapture, writeBaseline } from "../contracts";
import { loadManifest } from "../manifest";
import { err, info, ok } from "../util";

/**
 * Record the current contract fingerprint(s) as the accepted baseline.
 * Run this deliberately after an INTENDED contract change — it is separate from
 * `sync` on purpose, so a breaking change is never rubber-stamped silently.
 */
export function acceptContractCmd(repo: string, id?: string): number {
  const m = loadManifest(repo);
  const withSnapshot = (m.contracts ?? []).filter((c) => c.snapshot);
  const targets = id ? withSnapshot.filter((c) => c.id === id) : withSnapshot;

  if (id && !targets.length) {
    err(`no contract with a snapshot command named "${id}"`);
    return 1;
  }
  if (!targets.length) {
    info("no contracts declare a `snapshot` command — nothing to accept");
    return 0;
  }

  let problems = 0;
  for (const c of targets) {
    const cap = runCapture(repo, c.snapshot!);
    if (!cap.ok) {
      err(`${c.id}: snapshot command ${cap.timedOut ? "timed out" : "failed"} (${c.snapshot})`);
      problems++;
      continue;
    }
    const prev = readBaseline(repo, c.id);
    writeBaseline(repo, c.id, cap.stdout);
    ok(`${prev === null ? "created" : "updated"} baseline for ${c.id} -> .agents/contracts/${c.id}.snapshot`);
  }
  return problems ? 1 : 0;
}
