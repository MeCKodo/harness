import { printSkill } from "../skill";

const SKILL_REL = "skills/harness-check-loop/SKILL.md";

const META = `<!-- harness-kit check-loop -->
You are an AI agent implementing a requirement or fixing a bug in the CURRENT repo.
Follow the loop below. Run every harness-kit command through
\`npx -y @erzhe/harness-kit@latest <cmd>\` unless a local build is available.
The lifecycle hook records the SessionStart base, then runs \`run-checks + verify\` whenever you try to finish.
Use \`evidence\` to inspect the durable final result.

---

`;

export function checkLoopCmd(): number {
  return printSkill(SKILL_REL, META);
}
