import { join } from "node:path";
import type { Manifest } from "./manifest";
import { hashFile, readText, writeText } from "./util";

const STATE_REL = ".agents/.harness-state.json";

export interface HarnessState {
  // knowledge.path -> { boundSourceFile: sha256 }
  bindings: Record<string, Record<string, string>>;
}

export function computeBindings(repo: string, m: Manifest): HarnessState {
  const bindings: HarnessState["bindings"] = {};
  for (const k of m.knowledge ?? []) {
    if (!k.binds?.length) continue;
    bindings[k.path] = {};
    for (const f of k.binds) {
      bindings[k.path][f] = hashFile(join(repo, f)) ?? "(missing)";
    }
  }
  // Module cards auto-bind to their entry files: a card goes stale when its code moves.
  for (const mod of m.modules ?? []) {
    if (!mod.entry?.length) continue;
    const key = `module:${mod.name}`;
    bindings[key] = {};
    for (const f of mod.entry) {
      bindings[key][f] = hashFile(join(repo, f)) ?? "(missing)";
    }
  }
  return { bindings };
}

export function readState(repo: string): HarnessState | null {
  const raw = readText(join(repo, STATE_REL));
  return raw ? (JSON.parse(raw) as HarnessState) : null;
}

export function writeState(repo: string, s: HarnessState): void {
  writeText(join(repo, STATE_REL), JSON.stringify(s, null, 2) + "\n");
}
