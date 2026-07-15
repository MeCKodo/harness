import fg from "fast-glob";
import picomatch from "picomatch";
import type { Manifest, TestTouchPolicy } from "./manifest";

export interface ValidationGateHealthIssue {
  level: "error" | "warn";
  gate: string;
  message: string;
}

const SCAN_OPTIONS = {
  onlyFiles: true,
  dot: true,
  followSymbolicLinks: false,
  ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
};

function matchingFiles(repoFiles: string[], globs: string[]): string[] {
  if (!globs.length) return [];
  const matches = picomatch(globs, { dot: true });
  return repoFiles.filter((file) => matches(file));
}

function issueLevel(policy: TestTouchPolicy): ValidationGateHealthIssue["level"] {
  return policy === "required" ? "error" : "warn";
}

/**
 * Repository-aware validation that cannot be expressed by schema alone.
 * Required acceptance coverage must exist, be reachable from production-owned
 * modules, and remain physically separate from their unit/prod file sets.
 */
export function inspectValidationGateHealth(repo: string, manifest: Manifest): ValidationGateHealthIssue[] {
  const issues: ValidationGateHealthIssue[] = [];
  // Always enumerate from the repository root. Passing a manifest glob such as
  // `e2e/**` directly to fast-glob would let a symlinked static base (`e2e ->
  // /outside`) escape even with followSymbolicLinks disabled. Matching the
  // manifest globs against this symlink-safe inventory keeps coverage physical.
  const repoFiles = fg.sync("**/*", { cwd: repo, ...SCAN_OPTIONS });
  for (const [id, gate] of Object.entries(manifest.validation?.gates ?? {})) {
    const acceptance = gate.acceptance;
    const acceptanceFiles = new Set<string>();
    if (acceptance) {
      const level = issueLevel(acceptance.test_touch);
      for (const glob of acceptance.tests) {
        const matches = matchingFiles(repoFiles, [glob]);
        for (const file of matches) acceptanceFiles.add(file);
        if (!matches.length) {
          issues.push({
            level,
            gate: id,
            message: `acceptance glob matches 0 files: ${glob}${level === "error" ? " — required acceptance coverage cannot be vacuous" : ""}`,
          });
        }
      }
    }

    const modules = (manifest.modules ?? []).filter((module) => module.gates?.includes(id));
    for (const module of modules) {
      const ownedFiles = new Set(matchingFiles(repoFiles, module.owns ?? []));
      if (ownedFiles.size === 0) {
        issues.push({
          level: "error",
          gate: id,
          message: `module ${module.name} owns matches 0 files — production changes cannot activate this gate`,
        });
      }
      if (!acceptance) continue;
      const unitFiles = new Set(matchingFiles(repoFiles, module.tests ?? []));
      const overlap = [...acceptanceFiles].filter((file) => ownedFiles.has(file) || unitFiles.has(file));
      if (overlap.length) {
        const shown = overlap.slice(0, 5).join(", ");
        issues.push({
          level: issueLevel(acceptance.test_touch),
          gate: id,
          message: `acceptance files overlap module ${module.name} owns/tests: ${shown}${overlap.length > 5 ? ` …(+${overlap.length - 5})` : ""} — unit or production files cannot satisfy gate acceptance touch`,
        });
      }
    }
  }
  return issues;
}
