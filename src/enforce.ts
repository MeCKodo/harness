import fg from "fast-glob";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Enforcement } from "./manifest";

export interface Violation {
  invariant: string;
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.agents/map/**"];

/** Run the declarative enforcement of one invariant. Deterministic, no LLM. */
export function runEnforcement(repo: string, invId: string, e: Enforcement): Violation[] {
  const globs = e.path_glob?.length ? e.path_glob : ["**/*"];
  const files = fg.sync(globs, {
    cwd: repo,
    onlyFiles: true,
    dot: false,
    ignore: DEFAULT_IGNORE,
  });

  const forbids = [...(e.forbid_pattern ?? []), ...(e.forbid_import ?? [])].map((s) => new RegExp(s));
  const requires = (e.require_pattern ?? []).map((s) => new RegExp(s));
  const requireHit = requires.map(() => false);

  const violations: Violation[] = [];

  for (const rel of files) {
    let content: string;
    try {
      content = readFileSync(join(repo, rel), "utf8");
    } catch {
      continue; // unreadable / binary
    }
    const lines = content.split("\n");
    lines.forEach((ln, i) => {
      for (const rx of forbids) {
        if (rx.test(ln)) {
          violations.push({
            invariant: invId,
            file: rel,
            line: i + 1,
            reason: `forbidden pattern /${rx.source}/`,
            snippet: ln.trim().slice(0, 120),
          });
        }
      }
    });
    requires.forEach((rx, idx) => {
      if (rx.test(content)) requireHit[idx] = true;
    });
  }

  requires.forEach((rx, idx) => {
    if (!requireHit[idx]) {
      violations.push({
        invariant: invId,
        file: "(scope)",
        line: 0,
        reason: `required pattern not found: /${rx.source}/`,
        snippet: "",
      });
    }
  });

  return violations;
}
