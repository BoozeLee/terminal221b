#!/usr/bin/env bash
# Assert the number of tests vitest actually EXECUTED.
#
# Why this is a script and not a line in vitest.config.ts:
# `executor.test.ts` contains six `it.skipIf(!HAS_BWRAP)` cases. Where bubblewrap
# is absent they are skipped, the run still exits 0, and the suite's own total
# drops by six with nothing in the output saying so. A test that never ran and a
# test that passed become indistinguishable. This script closes that.
#
# Why the bubblewrap check is here and not left to CI configuration:
# installing bubblewrap in CI is a deliberate choice that makes this number
# meaningful. Checking it is present means the floor cannot be satisfied by
# silently skipping the six cases it exists to count. If bubblewrap is missing,
# this fails loudly instead of passing quietly at 379.
#
# Usage: scripts/assert-test-count.sh [expected]   (default 385)
set -euo pipefail

EXPECTED="${1:-385}"
REPORT="$(mktemp "${TMPDIR:-/tmp}/t221b-vitest-XXXXXX")"
trap 'rm -f "$REPORT" 2>/dev/null || true' EXIT

if ! command -v bwrap >/dev/null 2>&1; then
  echo "::error::bubblewrap is absent, so the six it.skipIf(!HAS_BWRAP) cases in" >&2
  echo "::error::executor.test.ts would skip silently and the suite would report" >&2
  echo "::error::$((EXPECTED - 6)) instead of $EXPECTED. Install bubblewrap first." >&2
  exit 1
fi

# Two reporters: `default` so a human reading the CI log sees the suite, `json`
# so the count can be read without parsing it. Without the first, a green run
# prints one line and a red one prints an error with no context.
npx vitest run --reporter=default --reporter=json --outputFile="$REPORT" || {
  echo "::error::vitest itself failed; the count assertion does not run" >&2
  exit 1
}

# jq is not assumed to exist. node is, because the suite is a node suite.
# The report is read and parsed rather than require()d: the temp file has no .json
# suffix, and require() would treat it as CommonJS and throw on the first colon.
read -r TOTAL FILES EXEC < <(node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write([
    r.numTotalTests ?? 0,
    r.numTotalTestSuites ?? 0,
    r.numPassedTests ?? 0,
  ].join(" ") + "\n");
' "$REPORT")

echo "executed: ${EXEC}/${TOTAL} tests across ${FILES} files (floor ${EXPECTED})"

if [ "$EXEC" -lt "$EXPECTED" ]; then
  echo "::error::only ${EXEC} tests executed, expected at least ${EXPECTED}." >&2
  echo "::error::A drop of six is the bubblewrap skipIf set going quiet." >&2
  exit 1
fi

if [ "$EXEC" -ne "$TOTAL" ]; then
  echo "::error::${TOTAL} tests were collected but only ${EXEC} ran." >&2
  exit 1
fi
