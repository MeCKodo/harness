import { captureLegacyEntries } from "../adoption";
import { inspectManagedFiles, writeManagedFiles, type ManagedFileTarget } from "../managed-files";
import { err, info, ok } from "../util";
import pkg from "../../package.json";
import { initialUpgradeState, UPGRADE_STATE_REL } from "../upgrade";

function manifestTemplate(name: string): string {
  return `spec: ai-harness/v0

identity:
  name: ${name}
  summary: TODO one-line description of what this repo is
  scope_in: []
  scope_out: []
  upstream: []
  downstream: []

capabilities:
  setup:  { run: "pnpm install" }
  build:  { run: "pnpm build" }
  test:   { run: "pnpm test" }
  lint:   { run: "pnpm lint" }
  verify: { run: "harness-kit verify" }

environment: []

contracts: []

invariants:
  - id: no-console-log
    rule: No stray console.log left in source
    enforcement:
      forbid_pattern: ["console\\\\.log\\\\("]
      path_glob: ["src/**"]
  - id: no-hardcoded-secret
    rule: Do not hardcode secrets / tokens in source
    enforcement:
      forbid_pattern: ["(password|secret|token)\\\\s*[:=]\\\\s*[\\"'][^\\"']+[\\"']"]
      path_glob: ["src/**"]

knowledge:
  - path: knowledge/domain.md
    role: domain
  - path: knowledge/conventions.md
    role: conventions
  - path: knowledge/journal/
    role: journal

playbooks:
  dir: playbooks/
`;
}

export function initCmd(repo: string, name: string, force: boolean): number {
  const targets: ManagedFileTarget[] = [
    [".agents/manifest.yaml", manifestTemplate(name)],
    [UPGRADE_STATE_REL, initialUpgradeState(pkg.name, pkg.version, "ai-harness/v0")],
    [
      ".agents/knowledge/domain.md",
      `# ${name} — domain\n\nWhat this project does and its key concepts.\nWrite only what an agent cannot infer from the code.\n`,
    ],
    [
      ".agents/knowledge/conventions.md",
      "# Conventions\n\nNaming, patterns, and style preferences that are not obvious from the code.\n",
    ],
    [".agents/knowledge/journal/.gitkeep", ""],
    [".agents/playbooks/.gitkeep", ""],
    [".agents/adoption.md", adoptionTemplate()],
  ];

  // This check deliberately happens before legacy capture: a normal init that
  // finds any scaffold target must be a true zero-write refusal, including no
  // adoption index or snapshots. writeManagedFiles repeats the same policy on
  // its own preflight so a target racing into existence is never overwritten.
  const collisions = inspectManagedFiles(repo, targets).filter((target) => target.kind !== "missing");
  if (collisions.length && !force) {
    err(`init scaffold 已存在（用 --force 覆盖）: ${collisions.map((item) => item.relativePath).join(", ")}`);
    return 1;
  }

  const adoption = captureLegacyEntries(repo);
  if (adoption.entries.length)
    ok(`captured ${adoption.entries.length} legacy agent entry/entries under .agents/adoption/ (no root file overwritten)`);
  const result = writeManagedFiles(repo, targets, {
    authorize: (inspections) => {
      if (force) return;
      const appeared = inspections.filter((target) => target.kind !== "missing");
      if (appeared.length)
        throw new Error(`init scaffold changed after preflight: ${appeared.map((item) => item.relativePath).join(", ")}`);
    },
  });
  for (const path of result.written) ok(`wrote ${path}`);

  info("\nNext: edit .agents/manifest.yaml, then run `harness-kit sync`.");
  return 0;
}

function adoptionTemplate(): string {
  return `# Tooling adoption log

Earn heavier tooling with evidence. Default posture: prefer the lightest thing that works,
and only promote a convention to a machine check (\`harness-kit verify\`) after it actually bites.

## When to promote a soft convention to an enforced invariant
- The same mistake slipped through 3+ times, OR
- A manual convention held for 1+ week and is clearly worth locking in.

## Log
- (date) observation / friction / decision
`;
}
