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
  timedOut?: boolean;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Run a repo-provided command and capture stdout. The CLI stays protocol-agnostic:
 * it never parses the output, it only compares it against a stored baseline.
 */
export function runCapture(repo: string, cmd: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Capture {
  if (timeoutMs <= 0) return { ok: false, stdout: "", error: "verification command budget exhausted", timedOut: true };
  try {
    const stdout = execSync(cmd, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.max(1, timeoutMs),
      killSignal: "SIGTERM",
    });
    return { ok: true, stdout };
  } catch (e) {
    const error = e as Error & { code?: string };
    return { ok: false, stdout: "", error: error.message, timedOut: error.code === "ETIMEDOUT" };
  }
}

export function readBaseline(repo: string, id: string): string | null {
  return readText(baselinePath(repo, id));
}

export function writeBaseline(repo: string, id: string, content: string): void {
  writeText(baselinePath(repo, id), content);
}
