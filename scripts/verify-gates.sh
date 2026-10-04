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
gate_names=(
  "home-path self-test"
  "home-path audit"
  "workflow self-test"
  "workflow audit"
)
# Unquoted on purpose below, so the arguments are words rather than part of the
# filename. Every entry here is a literal in this file, so there is nothing to
# split that could be an injection.
gate_cmds=(
  "scripts/check-home-paths.sh --self-test"
  "scripts/check-home-paths.sh"
  "scripts/check-workflows-can-fail.sh --self-test"
  "scripts/check-workflows-can-fail.sh"
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
    printf '  FAILED: %s (exit %s)\n' "$name" "$status" >&2
    failures=$((failures + 1))
  fi
done

printf '\n'
if [ "$failures" -ne 0 ]; then
  printf '%s of %s gate(s) failed\n' "$failures" "${#gate_names[@]}" >&2
  exit 1
fi
printf 'all %s gate(s) passed\n' "${#gate_names[@]}"
