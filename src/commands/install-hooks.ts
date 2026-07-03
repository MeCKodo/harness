import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { err, info, ok, warn, writeText } from "../util";

const MARK = "harness-kit-managed-hook";

// Resolve the real hooks dir (handles worktrees / custom core.hooksPath).
function hooksDir(repo: string): string {
  const out = execSync("git rev-parse --git-path hooks", { cwd: repo, encoding: "utf8" }).trim();
  return resolve(repo, out);
}

function preCommit(): string {
  return `#!/bin/sh
# ${MARK} (pre-commit): regenerate agent files from the manifest and stage them,
# so generated docs never drift from .agents/manifest.yaml.
# Reset with \`harness-kit install-hooks --force\`; delete this file to remove.
[ -f .agents/manifest.yaml ] || exit 0
HK="\${HARNESS_KIT_CMD:-npx -y @erzhe/harness-kit@latest}"
if ! $HK sync --repo . >/dev/null; then
  echo "harness-kit: sync failed (run \\\`$HK sync\\\` to see why)" >&2
  exit 1
fi
git add AGENTS.md CLAUDE.md .agents >/dev/null 2>&1 || true
exit 0
`;
}

function prePush(): string {
  return `#!/bin/sh
# ${MARK} (pre-push): block the push when the agent context has drifted from code.
# Bypass once with \`git push --no-verify\`.
[ -f .agents/manifest.yaml ] || exit 0
HK="\${HARNESS_KIT_CMD:-npx -y @erzhe/harness-kit@latest}"
if ! $HK verify --repo .; then
  echo "" >&2
  echo "harness-kit: verify failed — agent context drifted from code." >&2
  echo "  self-heal: run an agent with \\\`$HK onboard\\\` and follow its Maintenance section," >&2
  echo "  then review the diff. Bypass once with \\\`git push --no-verify\\\`." >&2
  exit 1
fi
exit 0
`;
}

export function installHooksCmd(repo: string, force = false): number {
  let dir: string;
  try {
    dir = hooksDir(repo);
  } catch {
    err("not a git repo (git rev-parse failed) — run inside a git working tree");
    return 1;
  }

  const targets: [string, string][] = [
    ["pre-commit", preCommit()],
    ["pre-push", prePush()],
  ];

  for (const [name, body] of targets) {
    const p = join(dir, name);
    if (existsSync(p) && !force) {
      const cur = readFileSync(p, "utf8");
      if (!cur.includes(MARK)) {
        warn(`${name} exists and isn't harness-kit-managed — skipped (use --force to overwrite)`);
        continue;
      }
    }
    writeText(p, body);
    chmodSync(p, 0o755);
    ok(`installed ${name}`);
  }

  info(`\nHooks written to ${dir}`);
  info("pre-commit: regenerates agent files from the manifest and stages them.");
  info("pre-push:   runs `harness-kit verify` and blocks on drift (bypass: git push --no-verify).");
  info("override the CLI it calls with env HARNESS_KIT_CMD (e.g. for local dev).");
  return 0;
}
