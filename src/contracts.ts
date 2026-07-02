import { execSync } from "node:child_process";
import { join } from "node:path";
import { readText, writeText } from "./util";

/** Where an accepted contract baseline lives (commit this file). */
export function baselinePath(repo: string, id: string): string {
  return join(repo, ".agents/contracts", `${id}.snapshot`);
}

export interface Capture {
  ok: boolean;
  stdout: string;
  error?: string;
}

/**
 * Run a repo-provided command and capture stdout. The CLI stays protocol-agnostic:
 * it never parses the output, it only compares it against a stored baseline.
 */
export function runCapture(repo: string, cmd: string): Capture {
  try {
    const stdout = execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: "", error: (e as Error).message };
  }
}

export function readBaseline(repo: string, id: string): string | null {
  return readText(baselinePath(repo, id));
}

export function writeBaseline(repo: string, id: string, content: string): void {
  writeText(baselinePath(repo, id), content);
}
