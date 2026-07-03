import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err } from "../util";

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
const SKILL_REL = "skills/erzhe-harness-init/SKILL.md";

const META = `<!-- harness-kit onboard -->
You are an AI agent onboarding the CURRENT repository to harness-kit.
Follow the skill below verbatim. Run every harness-kit command through
\`npx -y @erzhe/harness-kit@latest <cmd>\` — always the latest version, no global install.
Do not fabricate: confirm uncertain fields with the user, and report honest GAPS.

---

`;

// The bundle runs from dist/harness-kit.cjs (pkg root is one level up); the dev
// source runs from src/commands/onboard.ts (repo root is two levels up). Try both.
function resolveSkill(): string | null {
  for (const up of ["..", join("..", "..")]) {
    const p = join(HERE, up, SKILL_REL);
    if (existsSync(p)) return p;
  }
  return null;
}

export function onboardCmd(): number {
  const p = resolveSkill();
  if (!p) {
    err(`bundled skill not found (${SKILL_REL})`);
    return 1;
  }
  process.stdout.write(META);
  process.stdout.write(readFileSync(p, "utf8"));
  return 0;
}
