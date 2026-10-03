#!/usr/bin/env bash
# Assert the two committed copies of the provider boundary are identical.
#
# The provider boundary is a security policy — no secrets, no wallet custody, no
# command execution — and two surfaces render it: the TypeScript CLI and the
# Rust TUI. They must never disagree. That they agreed before was a fact about
# there being only ONE file, not a guarantee; there is now one file per
# distribution, because each ships separately:
#
#   packages/cli/resources/provider-boundary.json      canonical, read at runtime
#                                                    by the npm package
#   packages/rust-tui/resources/provider-boundary.json  embedded at compile time
#                                                    by the crate, because
#                                                    include_str! cannot read
#                                                    outside a published crate
#
# A policy edit that updates one copy and not the other is therefore possible,
# and the failure mode is quiet: the TUI enforces a weaker boundary than the CLI
# and no test notices. The existing drift guards
# (packages/rust-tui/src/boundary_drift.rs and
# packages/cli/tests/boundary-drift.test.ts) do NOT catch this — they each read
# one file and prove that a renderer notices a mutation, which is a different
# question. This script is the one that answers "are the two files the same
# bytes?".
#
# It compares content, not mtime, and reports the first differing line so a
# failure names what actually broke rather than just which two files disagree.
#
# Usage: scripts/assert-boundary-copies-identical.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# See the note in scripts/assert-tarball-contents.sh: `rm` on this host is a shim
# that does not expand its argument, so `rm -f "$X"` cleans up nothing. Resolving
# it explicitly keeps these scripts correct on both this host and a normal one.
rm_impl() { command rm "$@"; }
CANONICAL="$REPO_ROOT/packages/cli/resources/provider-boundary.json"
MIRROR="$REPO_ROOT/packages/rust-tui/resources/provider-boundary.json"
# The file name is written in the failure message on purpose: "the copies
# differ" is a nuisance, "packages/rust-tui/resources/provider-boundary.json is
# stale" is a to-do.
REL_CANONICAL="packages/cli/resources/provider-boundary.json"
REL_MIRROR="packages/rust-tui/resources/provider-boundary.json"

fail() {
  echo "::error::$1" >&2
  exit 1
}

cd "$REPO_ROOT" || fail "repo root not found"

[ -f "$CANONICAL" ] || fail "${REL_CANONICAL} is missing; it is the canonical copy."
[ -f "$MIRROR" ] || fail "${REL_MIRROR} is missing.
The crate embeds the boundary at compile time and cannot read outside its own
directory, so it needs its own copy of the file. Copy ${REL_CANONICAL} there and
commit both together."

# Both files must parse as the same JSON *value*, not merely share bytes. A
# reformat by a different tool should not be a failure, but a reformat that
# changes a clause must be. Comparing the raw bytes is the stricter and simpler
# rule, and the mirror is produced by `cp`, so a formatting difference only ever
# arrives if someone hand-edited one side — which is exactly the thing to catch.
if cmp -s "$CANONICAL" "$MIRROR"; then
  echo "boundary copies: identical (${REL_CANONICAL} == ${REL_MIRROR})"
  exit 0
fi

echo "::error::the two provider-boundary copies have DIFFERENT content." >&2
echo "::error::  canonical: ${REL_CANONICAL}" >&2
echo "::error::  mirror:    ${REL_MIRROR}" >&2
echo "::error::sha256 canonical: $(sha256sum "$CANONICAL" | cut -d' ' -f1)" >&2
echo "::error::sha256 mirror:    $(sha256sum "$MIRROR" | cut -d' ' -f1)" >&2

# Name the first differing line. On a security policy, "the files differ" is not
# actionable; "line 31 differs" is.
#
# The diff is written to a file and read back, rather than piped into `head`.
# Piping it was a bug: under `set -o pipefail`, `head` closing the pipe early
# gives the command SIGPIPE and the script exits 141 — still red, but for a
# reason that has nothing to do with drift. A gate that fails with an exit code
# that misdescribes its own cause sends you to debug the wrong thing, which is
# the same defect that was fixed in assert-tarball-contents.sh.
if command -v diff >/dev/null 2>&1; then
  DIFF_OUT="$(mktemp "${TMPDIR:-/tmp}/t221b-boundary-XXXXXX")"
  if diff -u "$CANONICAL" "$MIRROR" > "$DIFF_OUT" 2>/dev/null; then
    :
  else
    echo "::error::first differences:" >&2
    head -20 "$DIFF_OUT" | sed 's/^/::error::  /' >&2
  fi
  rm_impl -f "$DIFF_OUT" 2>/dev/null || true
fi

echo "::error::fix: edit the canonical file (${REL_CANONICAL}) and copy it to" >&2
echo "::error::${REL_MIRROR} in the SAME commit. A boundary that differs between" >&2
echo "::error::the CLI and the TUI is a security boundary that one of them is" >&2
echo "::error::not enforcing." >&2
exit 1
