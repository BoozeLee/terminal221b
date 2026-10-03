#!/usr/bin/env bash
# Assert the crate can actually be published, without publishing it.
#
# `cargo publish --dry-run` performs the real packaging step and the real
# verification build, and uploads nothing. That is the difference from
# `cargo build --workspace`, which says nothing about whether the *packed* crate
# builds from its own contents — the one question that decides whether a publish
# succeeds or fails after the fact.
#
# The failure this exists to catch: a crate that builds in this repository
# because it can see the workspace around it, and fails on crates.io because the
# packed tarball does not contain what it needs. Every other gate in this
# repository runs against the working tree, so none of them can see that.
#
# It runs twice, on purpose. The first pass is `--no-verify`: fast, and its
# errors are about the manifest rather than about code. The second builds the
# packed crate. Separating them means a bad `readme` path and a compile error do
# not produce the same message, which is the difference between a red build you
# can act on and one you have to re-run by hand to understand.
#
# `--locked` so the gate cannot pass against a lockfile that differs from the
# committed one. A publish resolves its own dependency graph, and a graph that
# only resolves locally is not a graph that resolves there.
#
# Usage: scripts/assert-crate-publishable.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The crate name (Cargo.toml) and the directory name differ: the crate is
# terminal221b-tui, the workspace member directory is rust-tui. -p selects by
# crate name, the paths below by directory, and conflating the two is how this
# first asserted against a directory that does not exist.
CRATE="terminal221b-tui"
CRATE_DIR="rust-tui"
PKG_DIR="$REPO_ROOT/packages/$CRATE_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/t221b-crate-XXXXXX")"
# Best-effort: on a host where `rm` is wrapped by a trash helper an intercepted
# `rm -rf` can leave the directory behind. That must not turn a passing gate red.
trap 'rm -rf "$WORK" >/dev/null 2>&1 || true' EXIT

fail() {
  echo "::error::$1" >&2
  exit 1
}

cd "$REPO_ROOT" || fail "repo root not found"
[ -d "$PKG_DIR" ] || fail "packages/$CRATE_DIR is missing"

# The manifest must not name a readme that does not exist. crates.io warns rather
# than rejects, so this would otherwise be a permanent ignorable warning that a
# typo quietly turns into a published crate carrying no description of itself.
readme="$(sed -n 's/^readme *= *"\(.*\)"/\1/p' "$PKG_DIR/Cargo.toml" | head -1)"
if [ -n "$readme" ] && [ ! -f "$PKG_DIR/$readme" ]; then
  fail "Cargo.toml names readme = \"$readme\", which does not exist."
fi

# crates.io rejects a publish without these; everything else only warns. Asserting
# them here means an unpublishable manifest fails in CI rather than after the
# version has been permanently claimed.
for field in name version description license; do
  grep -qE "^${field} *=" "$PKG_DIR/Cargo.toml" \
    || fail "Cargo.toml is missing the required field: ${field}"
done

echo "crate: $CRATE"

echo "--- pass 1 of 2: packaging + metadata (no verification build) ---"
if ! cargo publish -p "$CRATE" --dry-run --locked --no-verify >"$WORK/log" 2>&1; then
  cat "$WORK/log" >&2
  fail "cargo publish --dry-run failed on packaging or metadata."
fi
# Show cargo's own findings. Its warnings here are the ones that would otherwise
# be invisible in a passing CI log: a typo in an optional field, a licence
# expression crates.io does not recognise.
sed -n '/warning/p' "$WORK/log" || true

echo "--- pass 2 of 2: verification build of the packed crate ---"
if ! cargo publish -p "$CRATE" --dry-run --locked >"$WORK/log" 2>&1; then
  tail -40 "$WORK/log" >&2
  fail "the packed crate does not build; it would fail on crates.io."
fi

echo "crate $CRATE: publishable — packaging, metadata, and verification build all pass"
