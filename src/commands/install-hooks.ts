import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../../package.json";
import { err, info, ok, warn, writeText } from "../util";
import { ALL_AGENTS, AgentTool, installStopHooks } from "./stop-hooks";

const MARK = "harness-kit-managed-hook";

export interface InstallHooksOpts {
  force?: boolean;
  git?: boolean; // install git pre-commit/pre-push hooks
  stop?: boolean; // install agent Stop hooks
  agents?: AgentTool[]; // which agent tools to install Stop hooks for (default: all)
  allowSharedGitHooks?: boolean; // acknowledge that native hooks affect every linked worktree
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface HooksPathConfig {
  scope: string;
  origin: string;
  value: string;
}

interface GitHookScope {
  hooksDir: string;
  commonDir: string;
  gitDir: string;
  worktrees: string[];
  hooksPathConfigs: HooksPathConfig[];
  hooksPathConfigRaw: string[];
  defaultHooksDirMatches: boolean;
}

type HookOwnership = "missing" | "managed" | "foreign";

function git(repo: string, args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function gitFailure(result: GitResult): string {
  return result.error?.message ?? (result.stderr.trim() || `git exited with status ${result.status ?? "unknown"}`);
}

function inspectGitHookScope(repo: string): { scope?: GitHookScope; failure?: string } {
  const hooks = git(repo, ["rev-parse", "--git-path", "hooks"]);
  if (hooks.status !== 0) return { failure: `git rev-parse --git-path hooks failed: ${gitFailure(hooks)}` };

  const common = git(repo, ["rev-parse", "--git-common-dir"]);
  if (common.status !== 0) return { failure: `git rev-parse --git-common-dir failed: ${gitFailure(common)}` };

  const current = git(repo, ["rev-parse", "--git-dir"]);
  if (current.status !== 0) return { failure: `git rev-parse --git-dir failed: ${gitFailure(current)}` };

  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return { failure: `git worktree list failed: ${gitFailure(listed)}` };
  const worktrees = listed.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  if (!worktrees.length) return { failure: "git worktree list returned no worktrees" };

  const configured = git(repo, ["config", "--show-origin", "--show-scope", "--get-all", "core.hooksPath"]);
  if (configured.status !== 0 && !(configured.status === 1 && !configured.stdout.trim())) {
    return { failure: `git config could not inspect core.hooksPath and its origin: ${gitFailure(configured)}` };
  }
  const hooksPathConfigRaw = configured.stdout.split(/\r?\n/).filter(Boolean);
  const hooksPathConfigs = hooksPathConfigRaw.flatMap((line) => {
    const scopeEnd = line.indexOf("\t");
    const originEnd = scopeEnd < 0 ? -1 : line.indexOf("\t", scopeEnd + 1);
    if (scopeEnd < 0 || originEnd < 0) return [];
    return [
      {
        scope: line.slice(0, scopeEnd),
        origin: line.slice(scopeEnd + 1, originEnd),
        value: line.slice(originEnd + 1),
      },
    ];
  });

  const hooksDir = resolve(repo, hooks.stdout.trim());
  const commonDir = resolve(repo, common.stdout.trim());
  const gitDir = resolve(repo, current.stdout.trim());
  return {
    scope: {
      hooksDir,
      commonDir,
      gitDir,
      worktrees,
      hooksPathConfigs,
      hooksPathConfigRaw,
      defaultHooksDirMatches: hooksDir === join(commonDir, "hooks"),
    },
  };
}

function hookOwnership(path: string): HookOwnership {
  try {
    if (!lstatSync(path).isFile()) return "foreign";
    return readFileSync(path, "utf8").includes(MARK) ? "managed" : "foreign";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "foreign";
  }
}

function hooksPathReason(scope: GitHookScope): string | null {
  if (!scope.hooksPathConfigRaw.length) {
    return scope.defaultHooksDirMatches
      ? null
      : `resolved hooks directory does not match ${join(scope.commonDir, "hooks")}; core.hooksPath origin is ambiguous`;
  }
  if (scope.hooksPathConfigs.length !== 1 || scope.hooksPathConfigRaw.length !== 1) {
    return `core.hooksPath is ambiguous: ${scope.hooksPathConfigRaw.join("; ")}`;
  }
  const config = scope.hooksPathConfigs[0]!;
  const kind = config.scope === "global" || config.scope === "system" ? config.scope : "custom";
  return `${kind} core.hooksPath is configured as ${config.value} by ${config.scope} config at ${config.origin}`;
}

function preCommit(): string {
  return `#!/bin/sh
# ${MARK} (pre-commit): regenerate agent files from the manifest and stage them,
# so generated docs never drift from .agents/manifest.yaml.
# Reset with \`harness-kit install-hooks --force\`; delete this file to remove.
[ -f .agents/manifest.yaml ] || exit 0
HK="\${HARNESS_KIT_CMD:-npx -y @erzhe/harness-kit@${pkg.version}}"
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
HK="\${HARNESS_KIT_CMD:-npx -y @erzhe/harness-kit@${pkg.version}}"
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

function installGitHooks(repo: string, force: boolean, allowSharedGitHooks: boolean): number {
  const inspected = inspectGitHookScope(repo);
  if (!inspected.scope) {
    err(`native Git hooks not installed: ${inspected.failure}`);
    return 1;
  }
  const scope = inspected.scope;

  const targets: [string, string][] = [
    ["pre-commit", preCommit()],
    ["pre-push", prePush()],
  ];
  const ownership = new Map(targets.map(([name]) => [name, hookOwnership(join(scope.hooksDir, name))]));

  const reasons: string[] = [];
  const configuredPathReason = hooksPathReason(scope);
  if (configuredPathReason) reasons.push(configuredPathReason);
  if (scope.worktrees.length > 1 && !allowSharedGitHooks) {
    reasons.push(
      `multiple Git worktrees (${scope.worktrees.length}: ${scope.worktrees.join(", ")}) share this hooks directory ` +
        `(current Git dir ${scope.gitDir}; common Git dir ${scope.commonDir})`,
    );
  }
  const foreign = targets.filter(([name]) => ownership.get(name) === "foreign").map(([name]) => name);
  if (foreign.length) {
    reasons.push(`foreign ${foreign.join(" and ")} hook${foreign.length === 1 ? " exists" : "s exist"}; --force only refreshes harness-kit-managed hooks`);
  }
  if (reasons.length) {
    err(`native Git hooks not installed in ${scope.hooksDir}: ${reasons.join("; ")}`);
    return 1;
  }
  if (scope.worktrees.length > 1) {
    warn(
      `native Git hooks in ${scope.hooksDir} affect ${scope.worktrees.length} worktrees; ` +
        "shared-hook scope explicitly allowed",
    );
  }

  for (const [name, body] of targets) {
    const p = join(scope.hooksDir, name);
    const wasManaged = ownership.get(name) === "managed";
    writeText(p, body);
    chmodSync(p, 0o755);
    ok(`${wasManaged ? (force ? "refreshed" : "updated") : "installed"} ${name}`);
  }

  info(`\nGit hooks written to ${scope.hooksDir}`);
  info("pre-commit: regenerates agent files from the manifest and stages them.");
  info("pre-push:   runs `harness-kit verify` and blocks on drift (bypass: git push --no-verify).");
  info("override the CLI it calls with env HARNESS_KIT_CMD (e.g. for local dev).");
  return 0;
}

export function installHooksCmd(repo: string, opts: InstallHooksOpts = {}): number {
  const force = opts.force ?? false;
  // Default (no selector) preserves old behavior: install git hooks only.
  const doGit = opts.git ?? !opts.stop;
  const doStop = opts.stop ?? false;

  let code = 0;
  if (doGit) code = installGitHooks(repo, force, opts.allowSharedGitHooks ?? false) || code;
  if (doStop) {
    if (doGit) info("");
    code = installStopHooks(repo, opts.agents?.length ? opts.agents : ALL_AGENTS, force) || code;
  }
  return code;
}
