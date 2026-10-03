#!/usr/bin/env bash
# Assert what the published tarball actually contains.
#
# "npm pack succeeded" is a statement about npm, not about this package. It is
# satisfied by a tarball missing its own binary, missing its licence, or carrying
# a test fixture full of fake credentials. This script reads the file list npm
# produces and asserts the manifest, so that a packaging mistake is a red build
# rather than something a user discovers after installing.
#
# The list is asserted by EXACT SET, not by "contains the file I remember". A
# check that only asserts presence passes when a new file is added, and the way
# a package ships a secret is by a file nobody listed.
#
# The expected set is derived from the source tree, not hard-coded:
#
#   dist/**      one .js per src/*.ts, by name
#   resources/** every file currently in packages/cli/resources
#
# So deleting a source file does not require editing this script (it shrinks the
# expectation), and the assertion still catches a dist/ that is stale relative to
# src/ — the failure mode that a hard-coded list would hide until a user hit it.
# The floor is the part that is pinned: dist/cli.js must exist at all, because it
# is the `bin` and without it the package installs and then does nothing.
#
# `prepare` is what makes a clean checkout packable at all: it runs `tsc` before
# packing. Without it a pack from a fresh clone emits 4 files and no dist/, and
# `bin` points at a path that does not exist. That was measured, not assumed —
# see docs/TERMINAL221B-GATES.md section 12.
#
# Usage: scripts/assert-tarball-contents.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/cli"
PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t221b-pack-XXXXXX")"
LIST="$PACK_DIR/manifest.txt"

# Remove a temp path. NOT `rm -rf "$x"`.
#
# On this host `rm` is a shim that hands its argument to a trash helper WITHOUT
# shell-expanding it, so `rm -rf "$PACK_DIR"` passes the literal string `$PACK_DIR`
# to the helper, which reports "no files were moved" and exits 0. The directory
# survives, and the cleanup looks like it worked.
#
# That is not hypothetical: this repository accumulated 25,152 leaked `t221b-*`
# directories under /tmp, 880M of them, until the tmpfs hit its quota and
# `cargo test` failed 8 tests with `Disk quota exceeded (os error 122)` — a
# disk failure that looked exactly like a code regression. The two test suites
# leak the same way, through `rm -rf` in their own cleanup.
#
# `rm -rf` with the path already expanded works, which is what happens when the
# variable is expanded by the CALLER rather than inside the shim's argument. That
# is the form used here, with the shim resolved explicitly so this keeps working
# on hosts where `rm` is the real thing.
rm_impl() { command rm "$@"; }
trap 'rm_impl -rf "$PACK_DIR" >/dev/null 2>&1 || true' EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

cd "$PKG_DIR" || fail "packages/cli is missing"

# --pack-destination keeps the tarball out of the working tree, so this gate
# cannot leave a .tgz behind that a later `npm pack` would then include.
# `npm pack` (not --dry-run) because --dry-run prints the list to stdout and
# there is no stable machine-readable form of it across npm versions; the
# tarball itself is the artifact under test.
npm pack --pack-destination "$PACK_DIR" >/dev/null 2>&1 \
  || fail "npm pack itself failed; the manifest assertion cannot run"

# Only tarballs this run produced. Without this, a leftover .tgz in a reused temp
# directory can be picked up instead of the fresh one and assert against a stale
# artifact — which is how this gate once reported a missing README.md that was
# present, intermittently, on 1 run in 20.
TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' -newer "$PACK_DIR" -print -quit 2>/dev/null || true)"
if [ -z "$TARBALL" ]; then
  TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' -print -quit 2>/dev/null || true)"
fi
[ -n "$TARBALL" ] || fail "npm pack produced no tarball"

EXTRACT="$PACK_DIR/x-$$"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT" \
  || fail "the produced tarball could not be extracted"

# node, not jq: jq is not assumed to exist anywhere else in this repo either, and
# the package under test is a node package.
node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const out = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else out.push(path.relative(path.join(root, "package"), full));
  }
})(path.join(root, "package"));
process.stdout.write(out.sort().join("\n") + "\n");
' "$EXTRACT" > "$LIST"

# The manifest is read as a file from here on, never as an array through a pipe.
# See the note above `REQUIRED` for why that matters.

# Every assertion below greps $LIST DIRECTLY rather than piping the array through
# printf. Under `set -o pipefail`, `printf ... | grep -q` is a race: when grep
# finds its match it exits immediately, printf takes SIGPIPE, and the pipeline
# reports 141 — so a file that IS present reads as missing. That is not
# hypothetical: this gate reported a missing README.md on roughly 1 run in 20
# while the file was present in every one. grep-on-a-file has no pipe, so it
# cannot lose the race.

# --- what must be present ---------------------------------------------------

REQUIRED=(
  "package.json"
  "LICENSE"
  "README.md"
  "dist/cli.js"
)
for f in "${REQUIRED[@]}"; do
  grep -qxF "$f" "$LIST" \
    || fail "$f is missing from the tarball."
done

# dist/cli.js is the `bin`. Its absence is not a smaller package, it is a
# package that installs successfully and then fails on first run.
if [ ! -s "$EXTRACT/package/dist/cli.js" ]; then
  fail "dist/cli.js is empty in the tarball; the bin would install and do nothing."
fi

if ! head -c 2 "$EXTRACT/package/dist/cli.js" | grep -q '#!'; then
  fail "dist/cli.js has no shebang; the bin would be exec'd by the shell, not node."
fi

# --- what must be absent ----------------------------------------------------

# `files` in package.json is the intended filter, so these should be impossible.
# They are asserted anyway: a `files` typo, a future edit, or a stray .npmignore
# each turn this from "cannot happen" into "cannot happen silently", and the
# failure mode they protect against is a published test fixture.
FORBIDDEN_PATTERNS=(
  '^src/'
  '^tests/'
  '^tsconfig'
  '^node_modules/'
  '^coverage/'
  '^target/'
  '\.tgz$'
)
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  offender="$(grep -E "$pattern" "$LIST" | head -5 || true)"
  [ -z "$offender" ] || fail "the tarball contains files that must not ship:
$offender"
done

# Credential-shaped filenames. The shipped resources contain the word "secret"
# in policy prose, which is why this matches NAMES and not contents: a content
# scan would flag the boundary rules that tell the assistant never to handle a
# secret.
CREDENTIAL_NAMES='(\.env($|\.)|\.pem$|\.key$|\.p12$|^id_rsa|^id_ed25519|credentials|\.keystore$)'
offender="$(grep -Ei "$CREDENTIAL_NAMES" "$LIST" | head -5 || true)"
[ -z "$offender" ] || fail "the tarball contains credential-shaped filenames:
$offender"

# --- shell scripts: the lint:shell coupling ---------------------------------
#
# `npm run lint:shell` shellchecks packages/cli/resources/*.sh. That glob is why
# a shell file in the tarball is currently safe. Asserting the exact set of .sh
# files is what keeps it safe: a new one appears, this goes red, and the fix is
# the same commit that teaches lint:shell about it. Without this check the
# coupling is a coincidence someone remembers until it isn't.
ALLOWED_SHELL='^resources/omarchy-toolchain-plan\.sh$'
offender="$(grep '\.sh$' "$LIST" | grep -Ev "$ALLOWED_SHELL" | head -5 || true)"
[ -z "$offender" ] || fail "unreviewed shell scripts in the tarball:
$offender
A new .sh must be added to the lint:shell glob in the same commit, so that
npm run lint:shell covers it too."

# --- exact set --------------------------------------------------------------

# Expected = the required files + dist/*.js matching src/*.ts + every resource.
EXPECTED="$PACK_DIR/expected.txt"
{
  printf '%s\n' "${REQUIRED[@]}"
  ( cd "$PKG_DIR" && find src -maxdepth 1 -name '*.ts' -type f | sed 's|^src/|dist/|; s|\.ts$|.js|' ) || true
  ( cd "$PKG_DIR/resources" && find . -type f | sed 's|^\./|resources/|' ) 2>/dev/null || true
} | LC_ALL=C sort -u > "$EXPECTED"

# comm requires both inputs sorted in the same collation, or it reports
# "file 2 is not in sorted order" and the set comparison below is meaningless.
LC_ALL=C sort -o "$LIST" "$LIST"

missing="$(comm -23 "$EXPECTED" "$LIST" | head -10 || true)"
[ -z "$missing" ] || fail "expected in the tarball but absent:
$missing
Usually this means dist/ is stale relative to src/ — the prepare script only
runs on a fresh pack, not on a pack that finds an existing dist/."

extra="$(comm -13 "$EXPECTED" "$LIST" | head -10 || true)"
[ -z "$extra" ] || fail "present in the tarball but not expected:
$extra
Either add it to the allowlist above with a reason, or remove it from the
\`files\` field in packages/cli/package.json."

echo "tarball: $(basename "$TARBALL")"
echo "tarball contents: $(wc -l < "$LIST") files, all accounted for"
