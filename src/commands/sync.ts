import { join } from "node:path";
import { loadManifest } from "../manifest";
import { renderTargets } from "../render";
import { computeBindings, writeState } from "../state";
import { info, ok, writeText } from "../util";

export function syncCmd(repo: string): void {
  const m = loadManifest(repo);
  info("Syncing generated files from .agents/manifest.yaml ...");
  for (const [rel, content] of renderTargets(m)) {
    writeText(join(repo, rel), content);
    ok(`wrote ${rel}`);
  }
  writeState(repo, computeBindings(repo, m));
  ok("updated freshness baseline (.agents/.harness-state.json)");
}
