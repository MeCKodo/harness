# Harness Kit 0.3 Local Loop Implementation Plan

> **For agentic workers:** implement each seam with focused node:test coverage, then run the full repository gates before consumer evaluation.

**Goal:** Make local harness onboarding safe, knowledge-aware, and verifiably active without publishing or changing consumer CI.

**Architecture:** Deterministic file generation, semantic context review, and lifecycle enforcement are separate layers. `sync` owns only generated artifacts; context baselines advance only after an Agent records a review; native Git hooks are installed only when their scope is provably local and conflict-free.

**Tech stack:** TypeScript, Node 18+, node:test, Commander, YAML, fast-glob/picomatch, Orca isolated worktrees.

## Global constraints

- Support manifest `spec: ai-harness/v0` only.
- Preserve existing consumer documents in place; never hard-code document directory names.
- Do not publish, push, edit consumer source repositories, install shared Git hooks in evaluation worktrees, or modify CI.
- Never report a check, lifecycle hook, or context review as active without durable evidence.

## Delivery tasks

- [x] Add strict schema/glob validation and machine-readable verify output.
- [x] Add transactional generated-file writes and safe CLAUDE alias handling.
- [x] Separate deterministic sync from context-review baselines; add repo-root knowledge and `record-context-review`.
- [x] Make Agent lifecycle hooks required and native Git hooks scope-aware/conflict-safe.
- [x] Keep generated AGENTS bootstrap-sized and strengthen lossless onboarding.
- [x] Bind first takeover to an external candidate bundle plus a declared blind-audit receipt; snapshot + flag alone cannot apply.
- [x] Harden init scaffolding, contract paths, total verify JSON, exact Hook identity, context-review orphaning, and mode-bound legacy evidence after adversarial review.
- [x] Keep nested instructions and referenced business documents in place; bind copies only inside the external blind-audit bundle.
- [x] Update examples, fixtures, public docs, CLI contract, and local package version.
- [x] Run full repository gates and local tarball smoke tests.
- [x] Run three-role evaluations in isolated Orca worktrees for `opera_ai_server` and `lemon8-ai-gulux`.
