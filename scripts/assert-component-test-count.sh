#!/usr/bin/env bash
# Assert the number of component tests jest actually EXECUTED.
#
# This is a second runner and a second count, deliberately. The vitest suite
# (scripts/assert-test-count.sh) cannot mount a React Native component, and
# ChatScreen — the only screen, 459 lines, and the surface a user actually
# touches — had no render coverage at all until the SDK 57 upgrade. So there are
# now two suites and two floors, and neither number is evidence about the other.
# The file globs keep them apart by name, not by hope:
#
#   vitest.config.ts  include  src/**\/*.{test,spec}.{ts,tsx}
#   jest.config.js    testMatch src/**\/*.jest.{ts,tsx}
#
# Why ONE floor here and TWO in the vitest script: that script has two because
# six tests are `it.skipIf(!sandbox)` and their execution genuinely depends on
# whether the host can build a bubblewrap sandbox. This suite has no such
# conditional skip, so a single number is the honest one. If a test here ever
# starts skipping by capability, this script needs the same treatment — a single
# number would then be quietly wrong on some hosts and nobody would know.
#
# The threshold lives here and in CI, not in jest.config.js, because a config
# file that judges the tests gets edited by the same change it would judge.
#
# Usage: scripts/assert-component-test-count.sh [expected-floor]   (default 4)
set -euo pipefail

FLOOR="${1:-4}"
REPORT="$(mktemp "${TMPDIR:-/tmp}/t221b-jest-XXXXXX")"
trap 'rm -f "$REPORT" 2>/dev/null || true' EXIT

# Two reporters are not available for jest the way they are for vitest, so the
# human-readable run is the console and the machine-readable count is the file.
npx jest --ci --json --outputFile="$REPORT" || {
  echo "::error::jest itself failed; the count assertion does not run" >&2
  exit 1
}

# jq is not assumed to exist. node is, because the suite is a node suite.
# Read and parsed rather than require()d: the temp file has no .json suffix and
# require() would treat it as CommonJS and throw on the first colon.
read -r TOTAL EXEC SKIPPED < <(node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const out = [r.numTotalTests ?? 0, r.numPassedTests ?? 0, r.numPendingTests ?? 0];
  process.stdout.write(out.join(" ") + "\n");
' "$REPORT")

echo "component tests: ${EXEC}/${TOTAL} executed (floor ${FLOOR})"

if [ "$EXEC" -lt "$FLOOR" ]; then
  echo "::error::only ${EXEC} component tests executed, expected at least ${FLOOR}." >&2
  echo "::error::A deleted or renamed *.jest.tsx test file shows up here as a" >&2
  echo "::error::count drop, not as a failure, because nothing failed." >&2
  exit 1
fi

if [ "$SKIPPED" -ne 0 ]; then
  # Every test in this suite runs unconditionally. A skip means someone gated a
  # test on something environmental, which reintroduces exactly the two-runner,
  # two-machine problem this script was written to avoid.
  echo "::error::${SKIPPED} component tests were skipped." >&2
  echo "::error::Nothing in this suite is capability-dependent, so a skip means a" >&2
  echo "::error::test that no longer proves anything. The floor above is a single" >&2
  echo "::error::number on purpose; if that stops being true, this check is wrong" >&2
  echo "::error::and the script needs the two-floor treatment instead." >&2
  exit 1
fi
