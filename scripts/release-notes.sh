#!/usr/bin/env bash
# Generate release notes from what was MEASURED, never from what someone
# remembered.
#
# The v1.0.0 release body said "445 tests (385 TS, 60 Rust)". The tree that day
# had 452. Nothing in the release pipeline could catch that, because the number
# was typed by a person and a person is not a gate. This script is the gate: it
# runs the suites (or reads a run log) and prints what came out.
#
# Every number below is produced by a command in this file. If a count cannot
# be measured, the script says so rather than printing a stale figure — a
# release note that says "not measured" is true, and one that says 445 when the
# suite ran 391 is not.
#
# Usage: scripts/release-notes.sh [tag]
#        T221B_COUNT_LOG=path  reuse counts from a run log instead of re-running
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "::error::repo root not found" >&2; exit 1; }

ARTIFACT_DIR="$REPO_ROOT/dist/release"

TAG="${1:-${GITHUB_REF_NAME:-unknown}}"
VERSION="$(node -p 'require("./packages/cli/package.json").version')"
CRATE_VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' packages/rust-tui/Cargo.toml | head -1)"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
SHORT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- counts: measured, or explicitly not measured ---------------------------
#
# T221B_COUNT_LOG lets CI pass in the counts it already measured, so the notes
# describe the run that produced the artifact rather than a second run. The
# fallback re-measures only when no log is supplied, and says so.

count_from_log() {
  # $1 = suite key (vitest, jest, rust)
  [ -n "${T221B_COUNT_LOG:-}" ] && [ -f "$T221B_COUNT_LOG" ] || return 1
  sed -n "s/^t221b-count-$1=//p" "$T221B_COUNT_LOG" | head -1
}

measure_vitest() {
  # A JSON reporter, not a parsed human line. The same reasoning as
  # assert-test-count.sh: parsing prose is how a count silently goes stale,
  # and `--reporter=basic` is not a valid reporter in vitest 5.
  #
  # READ and parsed, never require()d. mktemp gives a name with no .json
  # suffix, so require() treats it as CommonJS and throws on the first colon —
  # which is exactly the trap assert-test-count.sh documents. That failure is
  # silent here (stderr is discarded), which is why this looked like "not
  # measured" rather than an error.
  local report; report="$(mktemp "${TMPDIR:-/tmp}/t221b-notes-XXXXXX")"
  npx vitest run --reporter=json --outputFile="$report" >/dev/null 2>&1 || true
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(r.numPassedTests ?? 0));
  ' "$report" 2>/dev/null || echo ""
  command rm -f "$report" >/dev/null 2>&1 || true
}

measure_jest() {
  local report; report="$(mktemp "${TMPDIR:-/tmp}/t221b-notes-XXXXXX")"
  npx jest --ci --json --outputFile="$report" >/dev/null 2>&1 || true
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(r.numPassedTests ?? 0));
  ' "$report" 2>/dev/null || echo ""
  command rm -f "$report" >/dev/null 2>&1 || true
}

measure_rust() {
  cargo test --workspace --locked 2>/dev/null \
    | sed -n 's/^test result: ok\. \([0-9]\+\) passed.*/\1/p' | head -1
}

resolve_count() {
  local key="$1" measure="$2"
  local from_log; from_log="$(count_from_log "$key" || true)"
  if [ -n "$from_log" ]; then echo "$from_log"; return; fi
  "$measure" || true
}

VITEST_COUNT="$(resolve_count vitest measure_vitest)"
JEST_COUNT="$(resolve_count jest measure_jest)"
RUST_COUNT="$(resolve_count rust measure_rust)"

# --- artifact facts ---------------------------------------------------------

ARTIFACT=""
if [ -d "$ARTIFACT_DIR" ]; then
  ARTIFACT="$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.tar.gz' -print -quit 2>/dev/null || true)"
fi
if [ -n "$ARTIFACT" ] && [ -f "${ARTIFACT}.sha256" ]; then
  ARTIFACT_NAME="$(basename "$ARTIFACT")"
  ARTIFACT_SHA="$(cut -d' ' -f1 < "${ARTIFACT}.sha256")"
  ARTIFACT_SIZE="$(wc -c < "$ARTIFACT" | tr -d ' ')"
else
  ARTIFACT_NAME="(not built)"
  ARTIFACT_SHA="(not built)"
  ARTIFACT_SIZE="0"
fi

# A count that could not be measured is printed as such. Never as a number from
# memory — that is the failure this script exists to prevent.
fmt() { if [ -n "$1" ]; then echo "$1"; else echo "not measured"; fi; }

TOTAL_KNOWN=1
for c in "$VITEST_COUNT" "$JEST_COUNT" "$RUST_COUNT"; do
  [ -n "$c" ] || TOTAL_KNOWN=0
done
if [ "$TOTAL_KNOWN" -eq 1 ]; then
  TOTAL=$(( VITEST_COUNT + JEST_COUNT + RUST_COUNT ))
else
  TOTAL="not measured"
fi

cat <<NOTES
## ${TAG}

${TAG} of Terminal221b — TypeScript CLI (\`${VERSION}\`) and Rust TUI (\`${CRATE_VERSION}\`).

### Install

\`\`\`sh
curl -fsSL https://github.com/BoozeLee/terminal221b/releases/latest/download/install.sh | bash
\`\`\`

or, with npm: \`npm install -g terminal221b-cli\`
or, the Rust TUI: \`cargo install terminal221b-tui --version ${CRATE_VERSION}\`

### Artifact

| | |
|---|---|
| file | \`${ARTIFACT_NAME}\` |
| size | ${ARTIFACT_SIZE} bytes |
| sha256 | \`${ARTIFACT_SHA}\` |
| commit | \`${SHORT_COMMIT}\` (\`${COMMIT}\`) |

The installer verifies the sha256 before extracting. One tarball serves every
platform with Node 22 or later; the CLI has no runtime dependencies.

### Tests at this commit

| Suite | Count |
|---|---|
| vitest (\`packages/cli\`) | $(fmt "$VITEST_COUNT") |
| jest-expo (components) | $(fmt "$JEST_COUNT") |
| cargo (\`packages/rust-tui\`) | $(fmt "$RUST_COUNT") |
| **total** | **${TOTAL}** |

Licence: AGPL-3.0-only.
NOTES
