#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { initCmd } from "./commands/init";
import { syncCmd } from "./commands/sync";
import { doctorCmd } from "./commands/doctor";
import { verifyCmd } from "./commands/verify";
import { acceptContractCmd } from "./commands/accept";

function guard(fn: () => void | number): void {
  try {
    const code = fn();
    if (typeof code === "number") process.exitCode = code;
  } catch (e) {
    console.error(`  ERR  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const program = new Command();
program.name("harness-kit").description("AI-friendly repo harness").version("0.1.0");

const repoOf = (o: { repo: string }) => resolve(o.repo);

program
  .command("init")
  .description("scaffold .agents/ skeleton + starter manifest")
  .option("-C, --repo <dir>", "target repo dir", process.cwd())
  .option("--name <name>", "project name", "my-project")
  .option("--force", "overwrite existing manifest", false)
  .action((o) => guard(() => initCmd(repoOf(o), o.name, o.force)));

program
  .command("sync")
  .description("generate tool files (AGENTS.md, CLAUDE.md, .cursor rules) from manifest")
  .option("-C, --repo <dir>", "target repo dir", process.cwd())
  .action((o) => guard(() => syncCmd(repoOf(o))));

program
  .command("doctor")
  .description("dev-time health check: completeness, drift, freshness, tech debt")
  .option("-C, --repo <dir>", "target repo dir", process.cwd())
  .action((o) => guard(() => doctorCmd(repoOf(o))));

program
  .command("verify")
  .description("CI gate: run enforceable invariants + contracts + drift; nonzero on failure")
  .option("-C, --repo <dir>", "target repo dir", process.cwd())
  .action((o) => guard(() => verifyCmd(repoOf(o))));

program
  .command("accept-contract")
  .description("record current contract fingerprint(s) as the accepted baseline (after an intended change)")
  .option("-C, --repo <dir>", "target repo dir", process.cwd())
  .option("--id <id>", "only this contract (default: all with a snapshot command)")
  .action((o) => guard(() => acceptContractCmd(repoOf(o), o.id)));

program.parseAsync();
