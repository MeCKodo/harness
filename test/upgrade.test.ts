import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { type Manifest } from "../src/manifest";
import { renderTargets } from "../src/render";
import {
  initialUpgradeState,
  UPGRADE_REPORT_SCHEMA,
  UPGRADE_STATE_REL,
  upgradeRepository,
  type UpgradeState,
} from "../src/upgrade";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE = "@erzhe/harness-kit";
const TARGET = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
}).version;

const MANIFEST = `spec: ai-harness/v0

identity:
  name: upgrade-fixture
  summary: Upgrade fixture
`;

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message],
    { cwd: repo },
  );
}

function fixture(options: { generated?: boolean; lock?: string; agents?: string; manifest?: string } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-upgrade-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  const manifestSource = options.manifest ?? MANIFEST;
  writeFileSync(join(repo, ".agents/manifest.yaml"), manifestSource);
  if (options.generated !== false) {
    const manifest = YAML.parse(manifestSource) as Manifest;
    for (const [path, content] of renderTargets(manifest)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), options.agents && path === "AGENTS.md" ? options.agents : content);
    }
  }
  if (options.lock !== undefined) writeFileSync(join(repo, UPGRADE_STATE_REL), options.lock);
  commit(repo, "fixture");
  return repo;
}

function upgrade(repo: string, check = false) {
  return upgradeRepository(repo, { packageName: PACKAGE, targetVersion: TARGET, check });
}

test("upgrade --check reports a missing durable state without writing", () => {
  const repo = fixture();
  const beforeManifest = readFileSync(join(repo, ".agents/manifest.yaml"), "utf8");
  const report = upgrade(repo, true);
  assert.equal(report.schema, UPGRADE_REPORT_SCHEMA);
  assert.equal(report.status, "upgrade-available");
  assert.deepEqual(report.pendingMigrations, ["upgrade-state-v1"]);
  assert.deepEqual(report.changedFiles, [UPGRADE_STATE_REL]);
  assert.equal(report.hooksChanged, false);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
  assert.equal(readFileSync(join(repo, ".agents/manifest.yaml"), "utf8"), beforeManifest);
});

test("upgrade applies once, preserves manifest bytes, and is current after commit", () => {
  const repo = fixture();
  const beforeManifest = readFileSync(join(repo, ".agents/manifest.yaml"), "utf8");
  const first = upgrade(repo);
  assert.equal(first.status, "upgraded");
  assert.deepEqual(first.changedFiles, [UPGRADE_STATE_REL]);
  assert.equal(readFileSync(join(repo, ".agents/manifest.yaml"), "utf8"), beforeManifest);
  const state = JSON.parse(readFileSync(join(repo, UPGRADE_STATE_REL), "utf8")) as UpgradeState;
  assert.deepEqual(state, {
    schema: "ai-harness/upgrade-state/v1",
    package: PACKAGE,
    version: TARGET,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  });
  commit(repo, "upgrade");
  const second = upgrade(repo);
  assert.equal(second.status, "current");
  assert.deepEqual(second.changedFiles, []);
});

test("upgrade refreshes managed generated files together with durable state", () => {
  const repo = fixture();
  const managedDrift = `${readFileSync(join(repo, "AGENTS.md"), "utf8")}managed drift\n`;
  writeFileSync(join(repo, "AGENTS.md"), managedDrift);
  commit(repo, "managed drift");
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.deepEqual(report.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.doesNotMatch(readFileSync(join(repo, "AGENTS.md"), "utf8"), /managed drift/);
});

test("upgrade advances the package version even when all migrations were already applied", () => {
  const repo = fixture({ lock: initialUpgradeState(PACKAGE, "0.5.0", "ai-harness/v0") });
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.deepEqual(report.pendingMigrations, []);
  assert.deepEqual(report.changedFiles, [UPGRADE_STATE_REL]);
  assert.equal((JSON.parse(readFileSync(join(repo, UPGRADE_STATE_REL), "utf8")) as UpgradeState).version, TARGET);
});

test("upgrade leaves repository lifecycle hook bytes untouched", () => {
  const repo = fixture();
  const hook = join(repo, ".agents/hooks/stop.sh");
  mkdirSync(join(repo, ".agents/hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\n# existing hook\n");
  commit(repo, "hook fixture");
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.equal(report.hooksChanged, false);
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\n# existing hook\n");
});

test("apply refuses a dirty repository with zero upgrade writes", () => {
  const repo = fixture();
  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.dirtyFiles, ["dirty.txt"]);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
});

test("invalid, foreign, and newer state all fail closed", () => {
  const invalid = fixture({ lock: "not json\n" });
  assert.match(upgrade(invalid).errors.join("\n"), /not valid JSON/);

  const foreign = fixture({ lock: initialUpgradeState("@example/other", "0.5.0", "ai-harness/v0") });
  assert.match(upgrade(foreign).errors.join("\n"), /belongs to @example\/other/);

  const newer = fixture({ lock: initialUpgradeState(PACKAGE, "9.0.0", "ai-harness/v0") });
  assert.match(upgrade(newer).errors.join("\n"), /refusing downgrade/);
});

test("upgrade refuses unmanaged generated entries and does not create state", () => {
  const repo = fixture({ agents: "# Hand-authored rules\n" });
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.match(report.errors.join("\n"), /拒绝覆盖未由 harness-kit 管理的文件: AGENTS.md/);
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "# Hand-authored rules\n");
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
});

test("an unsafe state target blocks before generated drift is written", () => {
  const repo = fixture();
  mkdirSync(join(repo, UPGRADE_STATE_REL), { recursive: true });
  writeFileSync(join(repo, UPGRADE_STATE_REL, "keep"), "keep\n");
  writeFileSync(join(repo, "AGENTS.md"), `${readFileSync(join(repo, "AGENTS.md"), "utf8")}drift\n`);
  commit(repo, "unsafe target");
  const before = readFileSync(join(repo, "AGENTS.md"), "utf8");
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), before);
});

test("CLI JSON check is one document and exits 2 when upgrade is available", () => {
  const repo = fixture();
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--check", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as { schema: string; status: string };
  assert.equal(report.schema, UPGRADE_REPORT_SCHEMA);
  assert.equal(report.status, "upgrade-available");
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI JSON apply includes post-upgrade doctor and verify without extra stdout", () => {
  const repo = fixture();
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as {
    status: string;
    verification: { doctor: { exitCode: number }; verify: { exitCode: number; report: { schema: string } } };
  };
  assert.equal(report.status, "upgraded");
  assert.equal(report.verification.doctor.exitCode, 0);
  assert.equal(report.verification.verify.exitCode, 0);
  assert.equal(report.verification.verify.report.schema, "ai-harness/verify-report/v1");
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI JSON reports incomplete verification after applying instead of losing the protocol", () => {
  const manifest = `${MANIFEST}\nknowledge:\n  - path: knowledge/missing.md\n    role: domain\n`;
  const repo = fixture({ manifest });
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as {
    status: string;
    changedFiles: string[];
    verification: { doctor: { exitCode: number } };
  };
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.changedFiles, [UPGRADE_STATE_REL]);
  assert.equal(report.verification.doctor.exitCode, 1);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});
