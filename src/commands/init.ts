import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, info, ok, writeText } from "../util";

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
  verify: { run: "mk-harness verify" }

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

export function initCmd(repo: string, name: string, force: boolean): void {
  const mp = join(repo, ".agents/manifest.yaml");
  if (existsSync(mp) && !force) {
    err(".agents/manifest.yaml 已存在（用 --force 覆盖）");
    return;
  }
  writeText(mp, manifestTemplate(name));
  ok("wrote .agents/manifest.yaml");

  writeText(
    join(repo, ".agents/knowledge/domain.md"),
    `# ${name} — domain\n\nWhat this project does and its key concepts.\nWrite only what an agent cannot infer from the code.\n`,
  );
  ok("wrote .agents/knowledge/domain.md");

  writeText(
    join(repo, ".agents/knowledge/conventions.md"),
    `# Conventions\n\nNaming, patterns, and style preferences that are not obvious from the code.\n`,
  );
  ok("wrote .agents/knowledge/conventions.md");

  writeText(join(repo, ".agents/knowledge/journal/.gitkeep"), "");
  writeText(join(repo, ".agents/playbooks/.gitkeep"), "");
  ok("created knowledge/journal/ and playbooks/");

  writeText(join(repo, ".agents/adoption.md"), adoptionTemplate());
  ok("wrote .agents/adoption.md");

  info("\nNext: edit .agents/manifest.yaml, then run `mk-harness sync`.");
}

function adoptionTemplate(): string {
  return `# Tooling adoption log

Earn heavier tooling with evidence. Default posture: prefer the lightest thing that works,
and only promote a convention to a machine check (\`mk-harness verify\`) after it actually bites.

## When to promote a soft convention to an enforced invariant
- The same mistake slipped through 3+ times, OR
- A manual convention held for 1+ week and is clearly worth locking in.

## Log
- (date) observation / friction / decision
`;
}
