# Lifecycle Hook resolves the pinned package outside the target repository

Date: 2026-07-14

## Decision

When `HARNESS_KIT_CMD` is not set, the generated Agent lifecycle runner changes only the package-resolution working directory to `${TMPDIR:-/tmp}` before invoking the pinned `@erzhe/harness-kit` version. The `hook-event --repo` argument still points at the real target repository.

## Why

`npx @erzhe/harness-kit@<version>` launched inside the harness-kit source checkout can mistake the same-named local project for the requested published package and fail with `harness-kit: command not found`. Resolving from a neutral directory avoids target-repository package shadowing and keeps source-repo dogfooding on the same pinned-package path as consumers. `HARNESS_KIT_CMD` remains the explicit local-development override.
