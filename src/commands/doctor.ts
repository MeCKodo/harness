import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, validateManifest } from "../manifest";
import { renderAgentsMd, renderTargets } from "../render";
import { computeBindings, readState } from "../state";
import { err, info, ok, readText, warn } from "../util";

// AGENTS.md must stay short (progressive disclosure): it is an index, not a dump.
const AGENTS_MAX_LINES = 150;
const AGENTS_MAX_WORDS = 700;

export function doctorCmd(repo: string): number {
  let problems = 0;
  const m = loadManifest(repo);

  info("1) Manifest validation");
  const issues = validateManifest(m);
  if (!issues.length) ok("schema looks good");
  for (const i of issues) {
    if (i.level === "error") {
      err(i.msg);
      problems++;
    } else {
      warn(i.msg);
    }
  }

  info("\n2) Referenced paths");
  const checkPath = (rel: string, label: string) => {
    if (existsSync(join(repo, ".agents", rel))) ok(`${label}: ${rel}`);
    else {
      err(`${label} missing: .agents/${rel}`);
      problems++;
    }
  };
  // repo-relative path referenced by routing/modules (e.g. src/server.ts)
  const checkRepoPath = (rel: string, label: string) => {
    if (existsSync(join(repo, rel))) ok(`${label}: ${rel}`);
    else {
      warn(`${label} points at a missing path: ${rel}`);
      problems++;
    }
  };
  for (const k of m.knowledge ?? []) checkPath(k.path, "knowledge");
  if (m.playbooks?.dir) checkPath(m.playbooks.dir, "playbooks");
  for (const r of m.routing ?? [])
    for (const p of new Set([...(r.read ?? []), ...(r.entry ?? [])])) checkRepoPath(p, `routing "${r.when}"`);
  for (const mod of m.modules ?? [])
    for (const p of new Set(mod.entry ?? [])) checkRepoPath(p, `module ${mod.name}`);

  info("\n3) Generated files drift");
  for (const [rel, content] of renderTargets(m)) {
    const cur = readText(join(repo, rel));
    if (cur === null) warn(`${rel} not generated yet (run \`mk-harness sync\`)`);
    else if (cur !== content) {
      err(`${rel} drifted from manifest (run \`mk-harness sync\`)`);
      problems++;
    } else ok(`${rel} in sync`);
  }

  info("\n4) Knowledge freshness");
  const prev = readState(repo);
  const now = computeBindings(repo, m);
  const boundCount = Object.keys(now.bindings).length;
  if (boundCount === 0) {
    ok("no knowledge bound to source files (nothing to drift)");
  } else if (!prev) {
    warn("no baseline yet (run `mk-harness sync` to record)");
  } else {
    let drift = 0;
    for (const [kp, files] of Object.entries(now.bindings)) {
      for (const [f, h] of Object.entries(files)) {
        const old = prev.bindings[kp]?.[f];
        if (old && old !== h) {
          const what = kp.startsWith("module:") ? "module card may be stale" : "knowledge may be stale";
          warn(`${kp}: bound file changed -> ${f} (${what})`);
          drift++;
        }
      }
    }
    if (!drift) ok("no knowledge drift");
  }

  info("\n5) Tech debt (manual invariants)");
  const manual = (m.invariants ?? []).filter((i) => i.manual);
  if (!manual.length) ok("no manual invariants");
  else warn(`${manual.length} manual (not machine-enforced): ${manual.map((i) => i.id).join(", ")}`);

  info("\n6) AGENTS.md size budget (must stay short — agents read it every session)");
  const agents = renderAgentsMd(m);
  const nLines = agents.split("\n").length;
  const nWords = agents.trim().split(/\s+/).length;
  if (nLines > AGENTS_MAX_LINES || nWords > AGENTS_MAX_WORDS) {
    warn(
      `AGENTS.md is ${nLines} lines / ${nWords} words (budget ${AGENTS_MAX_LINES}/${AGENTS_MAX_WORDS}). ` +
        "Move detail into .agents/knowledge/ and keep AGENTS.md as an index.",
    );
  } else {
    ok(`AGENTS.md ${nLines} lines / ${nWords} words (within budget)`);
  }

  info("");
  if (problems) {
    info(`doctor: ${problems} problem(s) found`);
    return 1;
  }
  info("doctor: healthy");
  return 0;
}
