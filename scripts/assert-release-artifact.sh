#!/usr/bin/env bash
# Assert the release ARTIFACT is correct, not the source tree it came from.
#
# The pack gate (assert-tarball-contents.sh) checks a tarball that npm is about
# to produce on this machine. This checks the file that will actually be
# uploaded: a different file, produced by a different command, in a different
# environment (CI), possibly re-uploaded by a human. A gate that only ever
# inspects the pre-upload state is not a gate on the release.
#
# It re-derives the rules from the EXTRACTED tarball rather than trusting the
# build. Everything here is about the bytes that will be downloaded by a user.
#
# Usage: scripts/assert-release-artifact.sh <path-to-tar.gz>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/cli"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/t221b-artifact-XXXXXX")"
rm_impl() { command rm "$@"; }
# cd OUT of the temp dir before the trap runs, and out of the repository too.
#
# This script cd's into the extracted package to read it, and a trash helper
# refuses to remove a directory that is an ANCESTOR OF THE CURRENT DIRECTORY —
# "trashing this directory would also remove the protected directory inside
# it". So a trap that simply deleted $WORK left the directory behind every time,
# once per run. Observed: 3 runs, 3 leftovers.
trap 'cd /; rm_impl -rf "$WORK" >/dev/null 2>&1 || true' EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

[ $# -ge 1 ] || fail "usage: scripts/assert-release-artifact.sh <path-to-tar.gz>"
# Resolve to an absolute path BEFORE any `cd` below. This script changes
# directory to extract the archive, and a relative path would stop resolving
# there — which is how the .sha256 check once silently passed as "no checksum
# file" against an artifact that had one.
ARTIFACT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$ARTIFACT" ] || fail "no such release artifact: $1"

# A renamed .tgz is still a gzip tar; prove it before extracting rather than
# letting tar print something cryptic.
file "$ARTIFACT" 2>/dev/null | grep -qE 'gzip compressed' \
  || fail "$ARTIFACT is not a gzip tarball"

EXTRACT="$WORK/x"
mkdir -p "$EXTRACT"
tar -xzf "$ARTIFACT" -C "$EXTRACT" || fail "the artifact could not be extracted"

# --- shape ------------------------------------------------------------------

# npm tarballs are rooted at `package/`. Anything else means a hand-made
# archive, and every rule below assumes this layout.
[ -d "$EXTRACT/package" ] || fail "the tarball has no top-level package/ directory"
TOP_LEVEL="$(find "$EXTRACT" -mindepth 1 -maxdepth 1 -printf '%f\n' | tr '\n' ' ')"
[ "$TOP_LEVEL" = "package " ] \
  || fail "the tarball must contain only package/ at the top level; found: $TOP_LEVEL"

cd "$EXTRACT/package" || fail "the extracted package is unreadable"

# --- manifest agreement -----------------------------------------------------
#
# The artifact must describe the same package the repository does. A tarball
# built from an older commit and uploaded under a newer tag is exactly the
# failure this catches, and it is invisible without opening the archive.

# SC2016 is suppressed for the next two blocks: the `${...}` inside the single
# quotes is a JavaScript template literal, not a shell expansion. Shellcheck
# reads it as an unexpanded shell variable, which is correct in general and
# wrong here — the single quotes are what keep the shell from touching it.
# shellcheck disable=SC2016
read -r NAME VERSION < <(node -e '
  const p = require(process.argv[1] + "/package.json");
  process.stdout.write(`${p.name} ${p.version}\n`);
' "$EXTRACT/package")

EXPECTED_NAME="$(node -p 'require("'"$PKG_DIR"'/package.json").name')"
EXPECTED_VERSION="$(node -p 'require("'"$PKG_DIR"'/package.json").version')"

[ "$NAME" = "$EXPECTED_NAME" ] \
  || fail "the artifact is $NAME but the manifest says $EXPECTED_NAME"
[ "$VERSION" = "$EXPECTED_VERSION" ] \
  || fail "the artifact is version $VERSION but the manifest says $EXPECTED_VERSION"

if [ "$NAME" != "terminal221b-cli" ]; then
  echo "::warning::the release artifact is $NAME, not the expected terminal221b-cli" >&2
fi

# --- required files ---------------------------------------------------------

for f in package.json LICENSE README.md dist/cli.js; do
  [ -f "$f" ] || fail "$f is missing from the release artifact."
done

# --- the bin must be runnable -----------------------------------------------
#
# The most important assertion here. An artifact whose bin does not exist
# installs successfully and then fails on first run, which is the failure mode
# the `prepare` script was added to prevent and the one a user actually
# experiences.

# shellcheck disable=SC2016
BIN_TARGET="$(node -e '
  const p = require(process.argv[1] + "/package.json");
  const b = p.bin;
  const v = typeof b === "string" ? b : Object.values(b)[0];
  process.stdout.write(v.replace(/^\.\//, "") + "\n");
' "$EXTRACT/package")"

[ -f "$BIN_TARGET" ] \
  || fail "the bin points at $BIN_TARGET, which is not in the artifact."
[ -s "$BIN_TARGET" ] \
  || fail "the bin ($BIN_TARGET) is empty; it would install and do nothing."

head -c 2 "$BIN_TARGET" | grep -q '#!' \
  || fail "the bin ($BIN_TARGET) has no shebang; it would be exec'd by the shell, not node."

# --- what must not ship -----------------------------------------------------
#
# The same denylist the pack gate applies. Duplicated deliberately: this gate
# runs on a different artifact in a different environment, and a shared
# implementation would mean the release inherits a bug in the pack gate's
# helper rather than stating its own rules.

FORBIDDEN='^(src/|tests/|tsconfig|node_modules/|coverage/|target/)|\.tgz$'
offender="$(find . -type f -not -path './package/*' -printf '%P\n' 2>/dev/null \
  | grep -E "$FORBIDDEN" | head -5 || true)"
[ -z "$offender" ] || fail "the release artifact contains files that must not ship:
$offender"

# Credential-shaped NAMES, never contents. resources/provider-boundary.json
# contains the words "secret" and "API keys" in its policy prose; a content scan
# would flag the very rules that forbid handling a secret.
CREDENTIAL_NAMES='(\.env($|\.)|\.pem$|\.key$|\.p12$|^id_rsa|^id_ed25519|credentials|\.keystore$)'
offender="$(find . -type f -not -path './package/*' -printf '%P\n' 2>/dev/null \
  | grep -Ei "$CREDENTIAL_NAMES" | head -5 || true)"
[ -z "$offender" ] || fail "the release artifact contains credential-shaped filenames:
$offender"

# --- the security policy must be present and unmodified --------------------
#
# This is the release-level statement of the invariant the in-repo gate
# (GATES.md section 14) enforces. The shipped CLI and the published crate
# must be enforcing the same boundary; if this file is stale, a user installs a
# policy weaker than the project believes it is shipping.

[ -f "resources/provider-boundary.json" ] \
  || fail "resources/provider-boundary.json is missing from the release artifact."

cmp -s "resources/provider-boundary.json" "$PKG_DIR/resources/provider-boundary.json" \
  || fail "the provider boundary in the artifact differs from the canonical one.
The CLI would enforce a different security policy than the repository declares."

# --- checksum file, if one is expected alongside ---------------------------

CHECKSUM="${ARTIFACT}.sha256"
if [ -f "$CHECKSUM" ]; then
  EXPECTED_SHA="$(cut -d' ' -f1 < "$CHECKSUM")"
  ACTUAL_SHA="$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
  [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] \
    || fail "the .sha256 does not match the artifact.
expected ${EXPECTED_SHA}
actual   ${ACTUAL_SHA}"
  echo "checksum: verified"
else
  echo "::warning::no .sha256 beside the artifact; the installer will refuse it" >&2
fi

COUNT="$(find . -type f -not -path './package/*' | wc -l | tr -d ' ')"
echo "release artifact: ${NAME}@${VERSION}"
echo "contents: ${COUNT} files, bin ${BIN_TARGET} runnable, provider boundary verified"
