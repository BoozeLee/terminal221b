#!/usr/bin/env bash
# Run every gate in this repository, in the order CI runs them.
#
# This exists because a gate nobody can run locally is a gate that gets deleted,
# and a gate that runs locally but not in CI is a gate that reports a green that
# verified nothing. Both are the same bug wearing different clothes. So there is
# one entry point, and CI calls this file rather than re-listing the steps: if
# the two ever diverge, the divergence is visible in one place.
#
# It is also the whole reason to have it while this account's private-repo
# Actions minutes are exhausted and CI cannot execute a job at all. The local
# path is the CI path, so "I could not run it here" stops being true.
#
# Every gate below audits the working tree, not a branch and not a ref, so a
# developer running this and CI running it on the same commit are looking at the
# same bytes and get the same answer. That equivalence is the property worth
# having, and it only holds while this file is the only list.
#
# Not the repository's test suite. This is the gates, and it does not claim to
# be more than that -- the two are different jobs and conflating them is how a
# green run ends up meaning only that the gates did not notice anything.
#
# Usage:
#   scripts/verify-gates.sh            run every gate
#   scripts/verify-gates.sh --list     print what it would run, and exit
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# name -> command. Order is the order CI runs them, and the reason is that the
# self-tests come first: if a gate cannot fail, its audit below proves nothing
# about the tree, so establish that the instruments work before trusting a
# reading from them.
# Every self-test runs before any audit. The reason is the whole reason this
# file exists: an audit performed by an instrument that cannot fail proves
# nothing about the tree, so the instruments are checked before a reading from
# them is believed.
gate_names=(
  "home-path self-test"
  "workflow self-test"
  "meta-gate self-test"
  "home-path audit"
  "workflow audit"
  "meta-gate audit"
)
# Unquoted on purpose below, so the arguments are words rather than part of the
# filename. Every entry here is a literal in this file, so there is nothing to
# split that could be an injection.
gate_cmds=(
  "scripts/check-home-paths.sh --self-test"
  "scripts/check-workflows-can-fail.sh --self-test"
  "scripts/check-gates-are-honest.sh --self-test"
  "scripts/check-home-paths.sh"
  "scripts/check-workflows-can-fail.sh"
  "scripts/check-gates-are-honest.sh"
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${gate_names[@]}"
  exit 0
fi

if [ "${#gate_names[@]}" -ne "${#gate_cmds[@]}" ]; then
  echo "verify-gates.sh: gate_names and gate_cmds disagree in length" >&2
  exit 1
fi

failures=0
for i in "${!gate_names[@]}"; do
  name="${gate_names[$i]}"
  printf '\n=== %s ===\n' "$name"
  # Not `if ! cmd`: that would make $? the status of the negation, so a failed
  # gate would be reported with exit 0 and read as a pass.
  ${gate_cmds[$i]}
  status=$?
  if [ "$status" -ne 0 ]; then
    # The exit code's meaning is the whole contract, so it is spelled out here
    # rather than left as a number. A 2 is not "found a problem", it is "looked
    # at nothing", and a reader who cannot tell those apart will file the second
    # as the first and go looking for a bug that is not in the code.
    case "$status" in
      1) why="findings" ;;
      2) why="inconclusive -- nothing was verified" ;;
      *) why="unexpected exit" ;;
    esac
    printf '  FAILED: %s (exit %s -- %s)\n' "$name" "$status" "$why" >&2
    failures=$((failures + 1))
  fi
done

printf '\n'
if [ "$failures" -ne 0 ]; then
  printf '%s of %s gate(s) failed\n' "$failures" "${#gate_names[@]}" >&2
  exit 1
fi
printf 'all %s gate(s) passed\n' "${#gate_names[@]}"
