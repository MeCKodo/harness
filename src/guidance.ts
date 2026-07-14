import type { AgentHookStatus } from "./hook-status";
import type { Manifest } from "./manifest";

export type VerificationGapClassification = "recommended" | "informational";

export type VerificationGapKind =
  | "manual-invariant"
  | "unenforced-invariant"
  | "manual-contract"
  | "unchecked-contract"
  | "mutating-capability"
  | "background-capability";

export interface VerificationGapDetail {
  id: string;
  kind: VerificationGapKind;
  scope: string;
  classification: VerificationGapClassification;
  title: string;
  reason: string;
  when: string;
  /** Kept byte-for-byte compatible with the v1 `gaps: string[]` field. */
  legacyText: string;
}

export interface VerificationGapSummary {
  total: number;
  recommended: number;
  informational: number;
}

export type HarnessActionPriority = "required" | "recommended";
export type HarnessActionOwner = "agent" | "human";
export type HarnessActionTiming = "before-finish" | "before-harness-ready" | "harness-maintenance";

export interface HarnessNextAction {
  id: string;
  priority: HarnessActionPriority;
  owner: HarnessActionOwner;
  when: HarnessActionTiming;
  title: string;
  reason: string;
  commands: string[];
  completion: string;
}

export interface EvidenceGuidanceInput {
  found: boolean;
  stale?: boolean;
  runChecksValid?: boolean;
  verifyPassed?: boolean;
  valid?: boolean;
}

export interface HarnessGuidance {
  gapDetails: VerificationGapDetail[];
  gapSummary: VerificationGapSummary;
  nextActions: HarnessNextAction[];
}

export interface HarnessGuidanceInput {
  manifest?: Manifest;
  hooks?: AgentHookStatus;
  evidence?: EvidenceGuidanceInput;
}

function gap(
  kind: VerificationGapKind,
  scope: string,
  classification: VerificationGapClassification,
  title: string,
  reason: string,
  when: string,
  legacyText: string,
): VerificationGapDetail {
  return { id: `${kind}:${scope}`, kind, scope, classification, title, reason, when, legacyText };
}

function declaredVerificationGaps(manifest: Manifest): VerificationGapDetail[] {
  const gaps: VerificationGapDetail[] = [];
  for (const invariant of manifest.invariants ?? []) {
    if (invariant.manual) {
      gaps.push(gap(
        "manual-invariant",
        invariant.id,
        "informational",
        `Review invariant ${invariant.id} when relevant`,
        invariant.rule,
        "Only when a change may affect this declared rule.",
        `invariant ${invariant.id}: manual, not machine-enforced — ${invariant.rule}`,
      ));
    } else if (!invariant.enforcement && !invariant.check) {
      gaps.push(gap(
        "unenforced-invariant",
        invariant.id,
        "recommended",
        `Add enforcement for invariant ${invariant.id}`,
        invariant.rule,
        "During onboarding or a dedicated Harness-maintenance task, not an unrelated product change.",
        `invariant ${invariant.id}: no enforcement/check declared — ${invariant.rule}`,
      ));
    }
  }

  for (const contract of manifest.contracts ?? []) {
    if (contract.check || contract.snapshot) continue;
    const legacyText =
      `contract ${contract.id}: no automatic check` +
      (contract.manual_verify ? ` — verify by hand: ${contract.manual_verify}` : "");
    if (contract.manual_verify) {
      gaps.push(gap(
        "manual-contract",
        contract.id,
        "informational",
        `Verify contract ${contract.id} when it changes`,
        contract.manual_verify,
        "Only when this contract is changed or before the release that carries it.",
        legacyText,
      ));
    } else {
      gaps.push(gap(
        "unchecked-contract",
        contract.id,
        "recommended",
        `Add a check or manual procedure for contract ${contract.id}`,
        "The contract has neither an automatic check nor a declared manual verification procedure.",
        "During onboarding or a dedicated Harness-maintenance task.",
        legacyText,
      ));
    }
  }

  for (const [verb, capability] of Object.entries(manifest.capabilities ?? {})) {
    if (capability.mutating) {
      gaps.push(gap(
        "mutating-capability",
        verb,
        "informational",
        `Run ${verb} only when deliberately requested`,
        `The command \`${capability.run}\` can change external or repository state, so verify never runs it automatically.`,
        "Only when the task explicitly requires this capability.",
        `capability ${verb} (\`${capability.run}\`): mutating — not run here, verify deliberately`,
      ));
    } else if (capability.background) {
      gaps.push(gap(
        "background-capability",
        verb,
        "informational",
        `Exercise ${verb} only when its runtime is relevant`,
        `The command \`${capability.run}\` is long-running, so verify does not start it.`,
        "Only for tasks that need the live service or background process.",
        `capability ${verb} (\`${capability.run}\`): long-running — not run in this gate`,
      ));
    }
  }
  return gaps;
}

function automationAction(gaps: VerificationGapDetail[]): HarnessNextAction | null {
  const recommended = gaps.filter((item) => item.classification === "recommended");
  if (!recommended.length) return null;
  return {
    id: "improve-verification-automation",
    priority: "recommended",
    owner: "agent",
    when: "harness-maintenance",
    title: `Improve ${recommended.length} verification declaration(s)`,
    reason:
      "These declarations have no executable check or complete manual procedure. They do not invalidate this run, but they weaken future coverage.",
    commands: ["harness-kit verify --repo . --details"],
    completion:
      "Each declaration has a real enforcement/check, or an explicit manual procedure when automation is genuinely impossible.",
  };
}

function evidenceOnlyIssue(issue: string): boolean {
  return /latest lifecycle evidence|start a new Agent session/.test(issue);
}

function unsafeHookIssue(issue: string): boolean {
  return /not valid hook JSON|not a safe .*regular file|unknown hooks shape|must be an array|foreign|belongs to another worktree/.test(
    issue,
  );
}

function hookActions(hooks: AgentHookStatus): HarnessNextAction[] {
  if (hooks.state === "active") return [];
  const configured = hooks.configuredAgents.join(",");
  if (hooks.state === "configured" || (hooks.configuredAgents.length > 0 && hooks.issues.every(evidenceOnlyIssue))) {
    return [{
      id: "prove-lifecycle-hooks",
      priority: "required",
      owner: "agent",
      when: "before-harness-ready",
      title: "Prove the lifecycle Hook in a fresh Agent session",
      reason:
        `A complete Hook is configured for ${configured || "the current Agent"}, but no current SessionStart + Stop evidence proves that the host executed it.`,
      commands: ["harness-kit evidence --repo . --json"],
      completion: "A newly created Agent session finishes once and evidence reports hookActive: true.",
    }];
  }

  const unsafe = hooks.issues.filter(unsafeHookIssue);
  if (unsafe.length) {
    return [{
      id: "review-lifecycle-hook-conflict",
      priority: "required",
      owner: "human",
      when: "before-harness-ready",
      title: "Approve resolution of an existing Hook configuration conflict",
      reason:
        "Harness found a Hook file or registration it cannot safely replace: " + unsafe.join("; "),
      commands: [],
      completion:
        "The user approves one exact proposed change; the Agent then installs safely and proves hookActive: true in a fresh session.",
    }];
  }

  const agents = configured || "<current-agent>";
  return [{
    id: hooks.configuredAgents.length ? "repair-lifecycle-hooks" : "install-lifecycle-hooks",
    priority: "required",
    owner: "agent",
    when: "before-harness-ready",
    title: hooks.configuredAgents.length ? "Repair the Agent lifecycle Hook" : "Install the Agent lifecycle Hook",
    reason:
      "Automatic SessionStart + Stop validation is not currently effective. The Agent should handle safe installation without asking the user to choose an implementation.",
    commands: [
      `harness-kit install-hooks --repo . --stop --agents ${agents}`,
      "harness-kit install-hooks --repo . --stop --agents codex --allow-user-dispatcher  # linked Codex worktree only",
      "harness-kit evidence --repo . --json  # after one fresh Agent session finishes",
    ],
    completion: "A fresh Agent session records both gates and evidence reports hookActive: true.",
  }];
}

function evidenceActions(evidence: EvidenceGuidanceInput): HarnessNextAction[] {
  if (!evidence.found) {
    return [{
      id: "record-delivery-evidence",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Create delivery evidence for this change",
      reason: "No run-checks + verify evidence exists for the current worktree/session.",
      commands: [
        "harness-kit run-checks --repo . --base <task-start-sha>",
        "harness-kit verify --repo .",
        "harness-kit evidence --repo . --json",
      ],
      completion: "Evidence reports valid: true for the current code fingerprint.",
    }];
  }
  if (evidence.stale) {
    return [{
      id: "refresh-stale-delivery-evidence",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Re-run validation for the current code",
      reason: "The saved green result belongs to an older code fingerprint.",
      commands: [
        "harness-kit run-checks --repo . --base <task-start-sha>",
        "harness-kit verify --repo .",
        "harness-kit evidence --repo . --json",
      ],
      completion: "Evidence is no longer stale and reports valid: true.",
    }];
  }
  if (!evidence.runChecksValid) {
    return [{
      id: "complete-run-checks",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Complete the impact-driven checks",
      reason: "The selected checks did not produce valid evidence for the current code.",
      commands: ["harness-kit run-checks --repo . --base <task-start-sha>", "harness-kit evidence --repo . --json"],
      completion: "Evidence reports runChecksValid: true for the current code fingerprint.",
    }];
  }
  if (!evidence.verifyPassed || !evidence.valid) {
    return [{
      id: "complete-verify",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Complete repository verification",
      reason: "Change checks passed, but matching verify evidence is missing or failed.",
      commands: ["harness-kit verify --repo .", "harness-kit evidence --repo . --json"],
      completion: "Evidence reports valid: true for the current code fingerprint.",
    }];
  }
  return [];
}

export function buildHarnessGuidance(input: HarnessGuidanceInput): HarnessGuidance {
  const gapDetails = input.manifest ? declaredVerificationGaps(input.manifest) : [];
  const nextActions = [
    ...(input.evidence ? evidenceActions(input.evidence) : []),
    ...(input.hooks ? hookActions(input.hooks) : []),
  ];
  const improvement = automationAction(gapDetails);
  if (improvement) nextActions.push(improvement);
  return {
    gapDetails,
    gapSummary: {
      total: gapDetails.length,
      recommended: gapDetails.filter((item) => item.classification === "recommended").length,
      informational: gapDetails.filter((item) => item.classification === "informational").length,
    },
    nextActions,
  };
}
