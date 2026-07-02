import { execSync } from "node:child_process";
import { join } from "node:path";
import { readBaseline, runCapture } from "../contracts";
import { runEnforcement } from "../enforce";
import { loadManifest } from "../manifest";
import { renderTargets } from "../render";
import { err, info, ok, readText, warn } from "../util";

function runCheck(repo: string, cmd: string): boolean {
  try {
    execSync(cmd, { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function verifyCmd(repo: string): number {
  const m = loadManifest(repo);
  let failures = 0;

  info("1) Generated files in sync");
  for (const [rel, content] of renderTargets(m)) {
    const cur = readText(join(repo, rel));
    if (cur === null) {
      err(`${rel} missing (run \`harness-kit sync\`)`);
      failures++;
    } else if (cur !== content) {
      err(`${rel} drifted from manifest (run \`harness-kit sync\`)`);
      failures++;
    } else ok(`${rel}`);
  }

  // Things we cannot check here — collected and reported honestly at the end.
  const gaps: string[] = [];

  info("\n2) Invariants");
  for (const inv of m.invariants ?? []) {
    if (inv.manual) {
      gaps.push(`invariant ${inv.id}: manual, not machine-enforced — ${inv.rule}`);
      continue;
    }
    if (inv.enforcement) {
      const v = runEnforcement(repo, inv.id, inv.enforcement);
      if (v.length) {
        failures++;
        err(`${inv.id}: ${v.length} violation(s)`);
        for (const x of v.slice(0, 10)) info(`       ${x.file}:${x.line}  ${x.reason}  | ${x.snippet}`);
      } else ok(`${inv.id}`);
    } else if (inv.check) {
      if (runCheck(repo, inv.check)) ok(`${inv.id} (check)`);
      else {
        failures++;
        err(`${inv.id}: check failed (${inv.check})`);
      }
    } else {
      gaps.push(`invariant ${inv.id}: no enforcement/check declared — ${inv.rule}`);
    }
  }

  const contracts = m.contracts ?? [];
  const autochecked = contracts.filter((c) => c.check || c.snapshot);
  if (autochecked.length) {
    info("\n3) Contracts");
    for (const c of autochecked) {
      if (c.check) {
        if (runCheck(repo, c.check)) ok(`${c.id} (check)`);
        else {
          failures++;
          err(`${c.id}: check failed (${c.check})`);
        }
      }
      if (c.snapshot) {
        const cap = runCapture(repo, c.snapshot);
        if (!cap.ok) {
          failures++;
          err(`${c.id}: snapshot command failed (${c.snapshot})`);
        } else {
          const base = readBaseline(repo, c.id);
          if (base === null) {
            warn(`${c.id}: snapshot baseline not set — run \`harness-kit accept-contract --id ${c.id}\``);
          } else if (base !== cap.stdout) {
            failures++;
            err(`${c.id}: contract drifted from baseline${c.breaking_needs ? ` (breaking -> ${c.breaking_needs})` : ""}`);
            info(`       if intended: bump version, then \`harness-kit accept-contract --id ${c.id}\``);
          } else ok(`${c.id} (snapshot)`);
        }
      }
    }
  }
  for (const c of contracts)
    if (!c.check && !c.snapshot)
      gaps.push(
        `contract ${c.id}: no automatic check` +
          (c.manual_verify ? ` — verify by hand: ${c.manual_verify}` : ""),
      );

  // Commands with side effects can't run in a plain CI gate — surface them as gaps.
  for (const [verb, c] of Object.entries(m.capabilities ?? {})) {
    if (c.mutating) gaps.push(`capability ${verb} (\`${c.run}\`): mutating — not run here, verify deliberately`);
    else if (c.background) gaps.push(`capability ${verb} (\`${c.run}\`): long-running — not run in this gate`);
  }

  info("\nGAPS — not verifiable here (report honestly, never fake)");
  if (!gaps.length) ok("no declared gaps");
  else for (const g of gaps) warn(g);

  info("");
  if (failures) {
    info(`verify: FAILED (${failures} problem(s), ${gaps.length} gap(s))`);
    return 1;
  }
  info(`verify: OK (${gaps.length} gap(s) — see above)`);
  return 0;
}
