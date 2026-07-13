import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err } from "./util";

// Locate this module's directory in both run modes:
// - esbuild CJS bundle (what `npx` runs): native `__dirname` exists.
// - tsx/ESM dev (`pnpm exec tsx`): `__dirname` is absent, derive from import.meta.url.
// `typeof` on an undeclared name is safe (no ReferenceError).
function moduleDir(): string {
  // @ts-ignore -- __dirname is provided by the CJS bundle, undefined under ESM
  if (typeof __dirname !== "undefined" && __dirname) return __dirname as string;
  return dirname(fileURLToPath(import.meta.url));
}

const HERE = moduleDir();

// The bundle runs from dist/harness-kit.cjs (pkg root is one level up); the dev
// source runs from src/*.ts (repo root is one/two levels up). Try each.
function resolveSkill(skillRel: string): string | null {
  for (const up of [".", "..", join("..", "..")]) {
    const p = join(HERE, up, skillRel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Print a bundled SKILL.md (optionally prefixed by a meta preamble). */
export function printSkill(skillRel: string, meta = ""): number {
  const p = resolveSkill(skillRel);
  if (!p) {
    err(`bundled skill not found (${skillRel})`);
    return 1;
  }
  if (meta) process.stdout.write(meta);
  process.stdout.write(readFileSync(p, "utf8"));
  return 0;
}
