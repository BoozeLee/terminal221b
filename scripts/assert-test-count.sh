#!/usr/bin/env bash
# Assert the number of tests vitest actually EXECUTED, and say which floor applied.
#
# Why this is a script and not a line in vitest.config.ts:
# `executor.test.ts` contains six `it.skipIf(!sandbox)` cases. Where a sandbox
# cannot be built they are skipped, the run still exits 0, and the suite's own
# total drops by six with nothing in the output saying so. A test that never ran
# and a test that passed become indistinguishable.
#
# Why there are two floors rather than one hard number:
# the six skipped cases are the ONLY reason the count moves. So the floor is a
# function of the same capability the tests gate on, probed here by the same code
# they use. 390 when a sandbox can be built; 384 when it cannot. Anything below
# 384 is a different problem and fails under every capability.
#
# The threshold is here and in CI, deliberately not in vitest.config.ts, because a
# config file that judges the tests gets edited by the same change it would judge.
#
# Usage: scripts/assert-test-count.sh [expected-full-floor]   (default 390)
set -euo pipefail

FULL_FLOOR="${1:-390}"
UNSANDBOXED_FLOOR=$((FULL_FLOOR - 6))
REPORT="$(mktemp "${TMPDIR:-/tmp}/t221b-vitest-XXXXXX")"
# `rm` on this host is a shim that does not expand its argument, so
# `rm -f "$REPORT"` removes nothing and the report file leaks on every run.
# Resolving it explicitly keeps this correct on both this host and a normal one.
rm_impl() { command rm "$@"; }
trap 'rm_impl -f "$REPORT" >/dev/null 2>&1 || true' EXIT

# One implementation of the probe, not two. The CLI already knows how to answer
# "can this host build a sandbox, and if not, which kind of no is it", and a
# second copy in bash would drift from it the first time the probe changed.
# SC2016 is suppressed for the next block: the `${...}` is a JS template
# substitution inside single quotes, deliberately not expanded by the shell.
# shellcheck disable=SC2016
PROBE="$(node --input-type=module -e '
  const { probeSandbox } = await import("./packages/cli/dist/executor.js");
  const c = probeSandbox();
  process.stdout.write(c.kind === "broken" ? `broken\t${c.detail}` : c.kind);
' 2>/dev/null || true)"

if [ -z "$PROBE" ]; then
  # The probe could not run at all — the CLI is not built, or node failed. That is
  # not the same as "no sandbox", so it is not treated as one.
  echo "::error::could not determine sandbox capability; build the CLI first" >&2
  echo "::error::(npm run build:cli) so this gate and the tests share one probe." >&2
  exit 1
fi

CAPABILITY="${PROBE%%$'\t'*}"
DETAIL="${PROBE#*$'\t'}"
[ "$DETAIL" = "$PROBE" ] && DETAIL=""

case "$CAPABILITY" in
  ok)
    FLOOR=$FULL_FLOOR
    REASON="sandbox available, full floor ${FULL_FLOOR}"
    ;;
  absent)
    FLOOR=$UNSANDBOXED_FLOOR
    REASON="bubblewrap is not installed, so 6 sandbox tests were skipped"
    ;;
  broken)
    FLOOR=$UNSANDBOXED_FLOOR
    REASON="bubblewrap is present but cannot build a sandbox, so 6 sandbox tests were skipped"
    ;;
  *)
    echo "::error::probe returned an unrecognised capability: ${CAPABILITY}" >&2
    exit 1
    ;;
esac

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
read -r TOTAL EXEC < <(node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write([r.numTotalTests ?? 0, r.numPassedTests ?? 0].join(" ") + "\n");
' "$REPORT")

echo "executed: ${EXEC}/${TOTAL} tests (${CAPABILITY}: ${REASON})"
if [ "$CAPABILITY" = "broken" ] && [ -n "$DETAIL" ]; then
  echo "  sandbox detail: ${DETAIL}"
fi

if [ "$EXEC" -lt "$UNSANDBOXED_FLOOR" ]; then
  echo "::error::only ${EXEC} tests executed, below the ${UNSANDBOXED_FLOOR} baseline" >&2
  echo "::error::that holds under every sandbox capability, so something other than" >&2
  echo "::error::the six sandbox skips is losing tests." >&2
  exit 1
fi

if [ "$EXEC" -lt "$FLOOR" ]; then
  echo "::error::only ${EXEC} tests executed, expected at least ${FLOOR}." >&2
  echo "::error::Applicable floor was ${FLOOR} because the probe said '${CAPABILITY}'." >&2
  exit 1
fi

if [ "$EXEC" -ne "$TOTAL" ]; then
  # Skips are only acceptable in the exact number the capability explains. Any
  # other gap between collected and executed is a silent skip nobody accounted
  # for, which is the failure this whole script exists to catch.
  SKIPPED=$((TOTAL - EXEC))
  if [ "$CAPABILITY" = "ok" ] || [ "$SKIPPED" -ne 6 ]; then
    echo "::error::${TOTAL} tests were collected but only ${EXEC} ran" >&2
    echo "::error::(${SKIPPED} skipped; the probe said '${CAPABILITY}', which accounts" >&2
    echo "::error::for 0 or 6, not ${SKIPPED}). Something is skipping silently." >&2
    exit 1
  fi
  echo "note: ${SKIPPED} tests skipped, all of them the sandbox suite, all accounted for"
fi
