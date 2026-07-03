#!/usr/bin/env bash
# Local regression over real-repo fixtures (fixtures/, git-ignored).
#
# Each fixture under fixtures/ is a copy of a REAL internal repo already
# onboarded to harness-kit (frontend monorepo / Go server / Node server / ...).
# We assert `doctor` and `verify` both exit 0 — i.e. a harness-kit change did
# not break support for a real-world project shape.
#
# Fixtures contain internal company code and are LOCAL-ONLY (see .gitignore).
# On a fresh clone fixtures/ is absent, so we skip cleanly instead of failing.
set -uo pipefail
cd "$(dirname "$0")/.."

CLI="dist/harness-kit.cjs"
[ -f "$CLI" ] || { echo "build first: pnpm build"; exit 1; }

if [ ! -d fixtures ]; then
  echo "no fixtures/ (local-only regression repos) — skipping"
  exit 0
fi

fail=0
found=0
for repo in fixtures/*/; do
  [ -f "${repo}.agents/manifest.yaml" ] || continue
  found=1
  name=$(basename "$repo")
  node "$CLI" doctor --repo "$repo" >/tmp/harness-reg-doctor.log 2>&1; d=$?
  node "$CLI" verify --repo "$repo" >/tmp/harness-reg-verify.log 2>&1; v=$?
  if [ "$d" -eq 0 ] && [ "$v" -eq 0 ]; then
    echo "  PASS  $name (doctor+verify exit 0)"
  else
    echo "  FAIL  $name (doctor=$d verify=$v)"
    echo "    --- doctor tail ---"; tail -6 /tmp/harness-reg-doctor.log | sed 's/^/    /'
    echo "    --- verify tail ---"; tail -6 /tmp/harness-reg-verify.log | sed 's/^/    /'
    fail=1
  fi
done

[ "$found" -eq 0 ] && { echo "fixtures/ has no onboarded repos — skipping"; exit 0; }
[ "$fail" -ne 0 ] && { echo "regression: FAILED"; exit 1; }
echo "regression: all fixtures green"
