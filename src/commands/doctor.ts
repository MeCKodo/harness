import fg from "fast-glob";
import { existsSync, statSync } from "node:fs";
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
  // Guard against a "vacuous pass": an enforcement whose path_glob matches no
  // files silently passes `verify` while checking nothing — worse than no gate.
  for (const inv of m.invariants ?? []) {
    if (!inv.enforcement) continue;
    const globs = inv.enforcement.path_glob?.length ? inv.enforcement.path_glob : ["**/*"];
    const n = fg.sync(globs, {
      cwd: repo,
      onlyFiles: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0)
      warn(`invariant ${inv.id}: enforcement path_glob matches 0 files — passes without checking anything (wrong path_glob for this repo layout?)`);
  }

  info("\n2) Referenced paths");
  const checkPath = (rel: string, label: string) => {
    if (existsSync(join(repo, ".agents", rel))) ok(`${label}: ${rel}`);
    else {
      err(`${label} missing: .agents/${rel}`);
      problems++;
    }
  };
  // repo-relative path referenced by routing/modules (e.g. src/server.ts).
  // wantFile=true for entry/binds: they hash a file for freshness, so pointing
  // at a directory is a config mistake — warn instead of silently OK-ing it.
  const checkRepoPath = (rel: string, label: string, wantFile = false) => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) {
      err(`${label} points at a missing path: ${rel}`);
      problems++;
    } else if (wantFile && statSync(abs).isDirectory()) {
      warn(`${label}: ${rel} is a directory — entry/binds should be a file (freshness hashes file content)`);
    } else ok(`${label}: ${rel}`);
  };
  for (const k of m.knowledge ?? []) {
    checkPath(k.path, "knowledge");
    for (const b of new Set(k.binds ?? [])) checkRepoPath(b, `knowledge "${k.path}" binds`, true);
  }
  if (m.playbooks?.dir) checkPath(m.playbooks.dir, "playbooks");
  // routing read/entry are navigation pointers (NOT freshness-bound) — dirs OK.
  for (const r of m.routing ?? [])
    for (const p of new Set([...(r.read ?? []), ...(r.entry ?? [])])) checkRepoPath(p, `routing "${r.when}"`);
  for (const mod of m.modules ?? [])
    for (const p of new Set(mod.entry ?? [])) checkRepoPath(p, `module ${mod.name}`, true);

  info("\n3) Generated files drift");
  for (const [rel, content] of renderTargets(m)) {
    const cur = readText(join(repo, rel));
    if (cur === null) warn(`${rel} not generated yet (run \`harness-kit sync\`)`);
    else if (cur !== content) {
      err(`${rel} drifted from manifest (run \`harness-kit sync\`)`);
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
    warn("no baseline yet (run `harness-kit sync` to record)");
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
