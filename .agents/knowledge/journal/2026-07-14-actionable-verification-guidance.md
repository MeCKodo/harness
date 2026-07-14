# Actionable verification guidance keeps gates read-only and lets Agents repair setup

Date: 2026-07-14

## Decision

`verify`, `doctor`, and `evidence` expose one shared guidance model. Declared verification boundaries are classified as:

- `recommended`: missing automation or an incomplete manual procedure, handled during onboarding or dedicated Harness maintenance;
- `informational`: deliberately on-demand work such as mutating release commands, background services, real-network checks, or an explicitly manual rule.

The existing `verify` JSON `gaps: string[]` remains for compatibility. Additive `gapDetails`, `gapSummary`, and `nextActions` tell callers what matters now, who owns it, when to act, the safe command, and the completion condition. Compact text hides individual non-blocking boundaries; `--details` expands them.

Lifecycle readiness is separate from gate success. `verify: OK` means declared deterministic gates passed. A missing, unproved, or stale SessionStart/Stop path produces a `required` action and `Harness readiness: INCOMPLETE`; ACTIVE evidence removes it.

## Ownership and mutation boundary

Health and gate commands remain read-only. They never install a Hook as a side effect. Generated `AGENTS.md` plus the bundled onboarding/check-loop skills require the current Agent to execute every `required | agent` action before claiming Harness readiness. Only an unsafe/unknown third-party Hook shape or a host trust prompt becomes `required | human`.

This separation preserves deterministic CLI behavior while making onboarding Agent-first: the user reviews one exact conflict or authorization, not a technical implementation choice.

## Why

A flat count such as “14 GAPS” mixes deliberate verification boundaries, future automation debt, and incomplete lifecycle setup. Users cannot infer whether they must act, and Agents summarize the same state inconsistently. One pure guidance module creates a stable seam shared by text output, JSON automation, and workflow instructions.
