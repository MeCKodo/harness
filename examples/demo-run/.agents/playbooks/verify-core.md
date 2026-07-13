# Playbook: verify core changes

How to verify a change to the `core` module.

1. `harness-kit plan-checks --repo .` — confirm `core` is in the affected modules and see the selected checks.
2. Add/adjust a test under `test/` that asserts the new behavior (for a bugfix, make it fail first, then pass).
3. `harness-kit run-checks --repo .` — must exit 0 with no unwaived blocking gaps.
