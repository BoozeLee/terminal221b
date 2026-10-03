#!/usr/bin/env bash
# Build the release tarball, deterministically, from a clean tree.
#
# A release is a statement about a commit. This script therefore refuses to run
# on a dirty tree rather than producing an artifact that no commit describes —
# which is the same rule `cargo publish` enforces, and for the same reason.
#
# It does NOT re-implement the tarball manifest rules. `assert-tarball-contents.sh`
# is the definition of a correct tarball, and a second definition in a second
# script would drift from the first the moment one of them was edited. This
# script runs that gate and then packs.
#
# No separate build step: `prepare` runs `tsc` during `npm pack`, so a clean
# checkout produces a correct tarball in one command. That is the whole reason
# `prepare` exists.
#
# Output lands in dist/release/, which .gitignore already covers. The tarball
# carries a sibling .sha256 because the installer refuses to extract a download
# it cannot verify.
#
# Usage: scripts/build-release.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/release"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/t221b-release-XXXXXX")"
# See the note in scripts/assert-tarball-contents.sh: `rm` on this host is a
# shim that does not expand its argument, so `rm -rf "$WORK"` cleans up nothing.
rm_impl() { command rm "$@"; }
trap 'rm_impl -rf "$WORK" >/dev/null 2>&1 || true' EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

cd "$REPO_ROOT" || fail "repo root not found"

# --- 1. the tree must be a commit -------------------------------------------

# `cargo publish` refuses a dirty tree for the same reason. A tarball built
# from uncommitted changes is not reproducible from the tag that points at it.
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "::error::the working tree is dirty; a release is a statement about a commit." >&2
  git status --short >&2
  exit 1
fi

# --- 2. the gates that define a correct tarball ------------------------------

echo "--- pack gate ---"
./scripts/assert-tarball-contents.sh \
  || fail "the tarball gate failed; refusing to build a release artifact from it."

echo "--- provider boundary copies ---"
./scripts/assert-boundary-copies-identical.sh \
  || fail "the CLI and the TUI are enforcing different provider boundaries."

# --- 3. pack ----------------------------------------------------------------

PKG_NAME="$(node -p 'require("./packages/cli/package.json").name')"
VERSION="$(node -p 'require("./packages/cli/package.json").version')"

mkdir -p "$OUT_DIR"
# Start from an empty directory so a previous build's tarball cannot be picked
# up as this one's output.
find "$OUT_DIR" -maxdepth 1 -name '*.tar.gz' -delete 2>/dev/null || true
find "$OUT_DIR" -maxdepth 1 -name '*.sha256' -delete 2>/dev/null || true

echo "--- npm pack ($PKG_NAME@$VERSION) ---"
# `npm pack` writes <name>-<version>.tgz; the release artifact is that file
# renamed with a .tar.gz extension, because that is what a user expects a
# "tarball" to be called and what tar(1) autodetects.
npm pack --pack-destination "$WORK" --workspace "$PKG_NAME" >/dev/null 2>&1 \
  || fail "npm pack failed"

PACKED="$(find "$WORK" -maxdepth 1 -name '*.tgz' -print -quit)"
[ -n "$PACKED" ] || fail "npm pack produced no tarball"

ARTIFACT="$OUT_DIR/${PKG_NAME}-${VERSION}.tar.gz"
cp "$PACKED" "$ARTIFACT"

# --- 4. checksum ------------------------------------------------------------
#
# The installer refuses a download it cannot verify, so the checksum is not an
# optional extra: without this file the install path has nothing to check.

( cd "$OUT_DIR" && sha256sum "$(basename "$ARTIFACT")" > "$(basename "$ARTIFACT").sha256" ) \
  || fail "could not compute the checksum"

SHA="$(cut -d' ' -f1 < "$ARTIFACT.sha256")"
SIZE="$(wc -c < "$ARTIFACT" | tr -d ' ')"

echo "release artifact: ${ARTIFACT#"$REPO_ROOT"/}"
echo "size:             ${SIZE} bytes"
echo "sha256:           ${SHA}"
echo "version:          ${VERSION} (${PKG_NAME})"
echo "commit:           $(git rev-parse HEAD)"
