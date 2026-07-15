# Platform-neutral repository upgrades

Date: 2026-07-16

## Decision

`harness-kit upgrade` upgrades repository-owned Harness state to the version of the currently running CLI. The core command is local and platform-neutral: it does not discover package versions, call npm, create branches, commit, push, open merge requests, or assume a CI provider. Callers choose how they obtain the binary, including public npm, an internal mirror, or a checked-in toolchain.

The repository records deterministic, reviewable state in `.agents/harness.lock.json`. It contains the package/version, live manifest spec, and ordered migration IDs. It has no timestamps and no list of AI agents. Migration rules are ordered and append-only; they cover mandatory structural changes only. Optional capabilities such as validation gates remain explicit repository design choices.

Apply mode requires a clean Git scope and computes the final manifest, generated entry files, and lock before writing them in one managed-file transaction. A parse-only pass preserves the manifest's exact bytes. `--check` is read-only, and `--json` emits one stable report for any Agent or automation layer.

Lifecycle Hooks are deliberately outside the 0.5.1 upgrade transaction. Their state may span repository files, Git administration paths, and user configuration, so `upgrade` neither installs nor refreshes them. Existing `install-hooks`, `doctor`, and `evidence` behavior remains explicit until the cross-agent Hook model is designed separately.
