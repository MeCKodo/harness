# Project-defined validation gates

Date: 2026-07-15
Status: accepted

## Context

Path-to-module impact mapping reliably selects declared checks, but a frontend or Electron module can still declare only unit tests. In that case a green run proves the configured checks passed, not that a user-visible workflow was exercised. A profile can also intentionally select a smaller ordinary checkset, so using profiles alone for E2E policy is too easy to weaken.

## Decision

Add project-defined `validation.gates` and let modules reference them with `modules[].gates`.

- Gates require `spec: ai-harness/v1`; v0 remains supported only for repositories without gates, so an older v0-only CLI rejects the new contract.
- A gate's `checks` are mandatory whenever a referencing module or the gate's acceptance files are affected. `--profile` cannot replace them.
- Every gate must be referenced by a module, and every referencing module must own at least one real repository file; check-only gates are not allowed to remain unreachable configuration.
- A gate may declare independent `acceptance.tests` plus an explicit `test_touch` policy. Ordinary module unit tests do not satisfy this touch requirement.
- Doctor, run-checks, and verify share a symlink-safe repository inventory for empty required acceptance coverage, dead production ownership, and acceptance overlap with module unit/production files.
- Evidence binds a deterministic validation-plan fingerprint. Evidence created before this binding remains readable but cannot become valid.
- Gate identifiers remain domain-neutral. The target repository names its own user-flow, IPC, migration, or other high-risk boundaries; Harness core does not infer frameworks or ship a frontend/Electron taxonomy.
- `doctor` rejects a required acceptance boundary whose globs match no files.

## Consequences

Repositories with real browser or desktop E2E suites can make those suites non-bypassable for relevant changes while preserving fast profiles for ordinary checks. Repositories without a real acceptance runner persist the concrete journey as a manual invariant instead of declaring a fictional command or test glob. More advanced automatic discovery can be added later without changing the gate contract.
