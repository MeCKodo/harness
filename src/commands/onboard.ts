import { printSkill } from "../skill";

const SKILL_REL = "skills/erzhe-harness-init/SKILL.md";

const META = `<!-- harness-kit onboard -->
You are an AI agent onboarding the CURRENT repository to harness-kit.
Follow the skill below verbatim. Run every harness-kit command through
\`npx -y @erzhe/harness-kit@latest <cmd>\` — always the latest version, no global install.
Do not fabricate: confirm uncertain fields with the user, and report honest GAPS.

---

`;

export function onboardCmd(): number {
  return printSkill(SKILL_REL, META);
}
