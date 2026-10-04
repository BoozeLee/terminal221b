#!/usr/bin/env bash
# Refuse a CI workflow that can report green without verifying anything.
#
# A gate that runs nothing is the most expensive kind of bug, because it is
# indistinguishable from a gate that passes. On 2026-10-04 every job on this
# account reported `conclusion: failure` with `steps: []` and `runner_name: ""`,
# and three pull requests merged with zero checks. Nothing in the diff said so.
# The only defence is a checker that looks at the workflow files themselves and
# refuses the shapes that cannot fail.
#
# Line-walking rather than a YAML parser, and that is deliberate: this repo does
# not depend on PyYAML, and adding a dependency to a gate that exists because
# the gates were not trusted is the wrong trade. The grammar this needs is
# small and the indentation it assumes is the indentation every workflow here
# already uses.
#
# Usage:
#   check-workflows-can-fail.sh [dir]      audit the workflows in <dir>
#   check-workflows-can-fail.sh --self-test  prove each check can fail
set -uo pipefail

# What a `run:` line is allowed to be and still count as able to fail. A step
# whose entire body is one of these cannot fail, whatever the repo around it
# does, so a job made only of them is a decoration.
TRIVIAL_RUN='^[[:space:]]*(echo[[:space:]]|true[[:space:]]*$|false[[:space:]]*$|:[[:space:]]*$|exit[[:space:]]+0[[:space:]]*$|printf?[[:space:]]+.*>/dev/null[[:space:]]*$)'

# Does a workflow file have a top-level `jobs:` mapping with at least one job?
# `^[^[:space:]#]` keeps comments out, and the second field guards against a
# `jobs:` mentioned inside a comment or a string.
has_jobs() {
  grep -qE '^jobs:[[:space:]]*$' "$1"
}

# Per-job analysis. Emits one line per job: "<job>\t<steps>\t<coe>\t<runs>\t<realruns>".
#
# Steps are six-space-indented `- ` entries under a four-space `steps:`. A
# `continue-on-error: true` belongs to the step above it, so the flag is
# recorded when seen and folded into the previous step when the step ends --
# which is why the running total is committed at the *next* step or at `end`.
job_report() {
  awk '
    function flush_step() {
      if (in_step) {
        steps++
        if (coe) coe_steps++
        if (has_run) {
          runs++
          if (!trivial) real_runs++
        } else if (is_checkout) checkouts++
        in_step = 0; has_run = 0; trivial = 0; coe = 0; is_checkout = 0
      }
    }
    function flush_job() {
      if (job == "") return
      flush_step()
      printf "%s\t%d\t%d\t%d\t%d\t%d\n", job, steps, coe_steps, runs, real_runs, checkouts
      job = ""; steps = 0; coe_steps = 0; runs = 0; real_runs = 0; checkouts = 0
    }
    /^[^[:space:]#]/ {
      flush_job()
      in_jobs = ($0 ~ /^jobs:[[:space:]]*$/)
      next
    }
    in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      flush_job()
      job = $0; sub(/^  /, "", job); sub(/:[[:space:]]*$/, "", job)
      next
    }
    job != "" && /^      - / {
      flush_step()
      in_step = 1
      line = $0
      if (line ~ /- run:[[:space:]]*/) {
        has_run = 1
        body = line; sub(/^ *- run:[[:space:]]*/, "", body)
        if (body ~ trivial_re) trivial = 1
        else trivial = 0
      } else {
        has_run = 0; trivial = 0
        is_checkout = (line ~ /- uses:[[:space:]]+actions\/checkout@/)
      }
      next
    }
    job != "" && in_step && /continue-on-error:[[:space:]]*true/ { coe = 1; next }
    END { flush_job() }
  ' trivial_re="$TRIVIAL_RUN" "$1"
}

# Exit 2 -- inconclusive, not clean. This gate's whole subject is the CI
# configuration, so a repository with no CI is not a repository that is fine; it
# is a repository this gate was unable to look at. Reporting that as a pass is
# the exact shape of bug this file exists to catch, applied to itself.
audit() {
  local dir="${1:-.}" min_subjects="${2:-1}" wf problems=0 checked=0
  local -a findings=()

  if [ ! -e "$dir" ]; then
    echo "$dir: inconclusive -- no such path; nothing was verified, and that is not a pass" >&2
    return 2
  fi
  if [ ! -d "$dir/.github/workflows" ]; then
    echo "$dir: inconclusive -- no .github/workflows directory, so there is no CI to audit." >&2
    echo "  That is a finding, not a pass: a repository with no CI has nothing checking" >&2
    echo "  it. Pass --min-subjects 0 to opt out deliberately." >&2
    return 2
  fi

  for wf in "$dir"/.github/workflows/*.yml "$dir"/.github/workflows/*.yaml; do
    [ -f "$wf" ] || continue
    checked=$((checked + 1))
    local name; name="$(basename "$wf")"

    if ! grep -qE '^on:[[:space:]]*$' "$wf"; then
      findings+=("$name: no top-level 'on:' -- this workflow never triggers")
      problems=$((problems + 1))
      continue
    fi
    if ! has_jobs "$wf"; then
      findings+=("$name: no top-level 'jobs:' -- there is nothing to run")
      problems=$((problems + 1))
      continue
    fi
    local report job_seen=0
    report="$(job_report "$wf")"
    while IFS=$'\t' read -r job steps coe_steps runs real_runs checkouts; do
      [ -n "${job:-}" ] || continue
      job_seen=1
      # A job whose only steps are `uses:` actions is NOT vacuous: the action
      # fails the job when it fails. So there is deliberately no "no run step"
      # rule here -- it would refuse actions/stale.yml, which is a real gate.
      if [ "${steps:-0}" -eq 0 ]; then
        findings+=("$name:$job: no steps -- the job cannot verify anything")
        problems=$((problems + 1))
      elif [ "${coe_steps:-0}" -eq "${steps:-0}" ]; then
        findings+=("$name:$job: every step is continue-on-error -- no step can fail this run")
        problems=$((problems + 1))
      elif [ "${runs:-0}" -gt 0 ] && [ "${real_runs:-0}" -eq 0 ]; then
        findings+=("$name:$job: every run step is trivially succeeding (echo/true/:/exit 0)")
        problems=$((problems + 1))
      elif [ "${runs:-0}" -eq 0 ] && [ "${checkouts:-0}" -eq "${steps:-0}" ]; then
        # An action-only job is fine -- actions/stale.yml is a real gate and has
        # no run step at all. But a job whose every step is *checkout* fetches
        # the code and does nothing with it, which is provable rather than a
        # judgement call, so it is refused here.
        findings+=("$name:$job: every step is actions/checkout -- it fetches the code and runs nothing")
        problems=$((problems + 1))
      fi
    done <<< "$report"
    if [ "$job_seen" -eq 0 ]; then
      findings+=("$name: 'jobs:' is present but lists no job -- a run with no job verifies nothing")
      problems=$((problems + 1))
    fi
  done

  if [ "$checked" -lt "$min_subjects" ]; then
    echo "$dir: inconclusive -- ${checked} workflow file(s) found, expected at least" \
      "${min_subjects}; nothing was verified, and that is not a pass" >&2
    return 2
  fi

  if [ "$problems" -ne 0 ]; then
    echo "$dir: ${problems} workflow problem(s) that can report green without verifying:" >&2
    for f in "${findings[@]}"; do echo "  $f" >&2; done
    echo "" >&2
    echo "  A workflow that cannot fail is not a check. Give the job a step that" >&2
    echo "  runs something whose exit code means something." >&2
    return 1
  fi
  echo "$dir: $checked workflow file(s), every job has a step that can fail"
  return 0
}

self_test() {
  local tmp status failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # Each control writes a workflow that must be REFUSED, and one that must be
  # accepted. A control that only ever proves the happy path is a decorator.
  # `setup` is optional: without it the fixture gets a workflows directory and a
  # workflow in it, which is the common case. "no workflows directory" and
  # "empty workflows directory" are both expressed by passing one, so they cannot
  # be confused with a fixture that simply has a clean workflow in it.
  control() {
    local label="$1" want="$2" body="$3" setup="${4:-with-workflow}"
    local d="$tmp/$label"
    case "$setup" in
      with-workflow)
        mkdir -p "$d/.github/workflows"
        printf '%s\n' "$body" > "$d/.github/workflows/w.yml" ;;
      no-dir)
        mkdir -p "$d" ;;
      empty-dir)
        mkdir -p "$d/.github/workflows" ;;
      *) echo "self-test FAILED: $label (unknown setup $setup)" >&2; failures=$((failures + 1)); return ;;
    esac
    audit "$d" >/dev/null 2>&1
    status=$?
    if [ "$status" -ne "$want" ]; then
      echo "self-test FAILED: $label (wanted exit $want, got $status)" >&2
      failures=$((failures + 1))
    else
      echo "self-test ok: $label (exit $status)"
    fi
  }

  local ok='name: CI
on:
  push:
jobs:
  q:
    runs-on: ubuntu-24.04
    steps:
      - run: npm test'

  local no_steps='name: CI
on:
  push:
jobs:
  q:
    runs-on: ubuntu-24.04
    steps: []'

  local empty_jobs='name: CI
on:
  push:
jobs:'

  local all_coe='name: CI
on:
  push:
jobs:
  q:
    runs-on: ubuntu-24.04
    steps:
      - run: npm test
        continue-on-error: true'

  local all_trivial='name: CI
on:
  push:
jobs:
  q:
    runs-on: ubuntu-24.04
    steps:
      - run: echo hello'

  local no_on='name: CI
jobs:
  q:
    runs-on: ubuntu-24.04
    steps:
      - run: npm test'

  local action_only='name: Stale
on:
  schedule:
    - cron: "0 0 * * *"
jobs:
  stale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/stale@v9'

  local checkout_only='name: CI
on:
  push:
jobs:
  q:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: actions/checkout@v7'

  # The three ways this gate has nothing to look at. A gate whose whole subject
  # is the CI configuration has to treat its own absence as a finding, and these
  # are the controls that make that non-vacuous: without the exit-2 paths all
  # three go red, because the audit would report a sound configuration it never
  # read.
  control refuses-no-workflows-dir 2 'name: x' no-dir
  control refuses-empty-workflows-dir 2 'name: x' empty-dir

  # A path that was never created. Written out rather than folded into the
  # helper, because the helper always makes a directory for the fixture.
  audit "$tmp/refuses-missing-path" 1 >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "self-test FAILED: refuses-missing-path (wanted exit 2, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-missing-path (exit $status)"
  fi

  # The floor, which is what makes "no CI" a finding rather than a pass.
  mkdir -p "$tmp/min-subjects/.github/workflows"
  printf '%s\n' "$ok" > "$tmp/min-subjects/.github/workflows/w.yml"
  audit "$tmp/min-subjects" 3 >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "self-test FAILED: min-subjects-floor (wanted exit 2, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: min-subjects-floor (exit $status)"
  fi
  # And met, the same tree, so the floor is a floor and not a wall.
  audit "$tmp/min-subjects" 1 >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "self-test FAILED: min-subjects-met (wanted exit 0, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: min-subjects-met (exit $status)"
  fi

  control accepts-a-real-run 0 "$ok"
  control refuses-a-checkout-only-job 1 "$checkout_only"
  control action-plus-run-is-not-vacuous 0 "$(printf '%s\n' "$action_only" | sed 's|      - uses: actions/stale@v9|      - uses: actions/stale@v9\n      - run: ./scripts/verify.sh|')"
  control action-only-job-is-not-vacuous 0 "$action_only"
  control refuses-a-job-with-no-steps 1 "$no_steps"
  control refuses-empty-jobs 1 "$empty_jobs"
  control refuses-all-continue-on-error 1 "$all_coe"
  control refuses-all-trivially-succeeding 1 "$all_trivial"
  control refuses-a-workflow-with-no-on 1 "$no_on"

  rm -rf "$tmp"
  trap - RETURN
  if [ "$failures" -ne 0 ]; then
    echo "self-test: $failures control(s) did not behave as specified" >&2
    return 1
  fi
  echo "self-test: a workflow that cannot fail is refused, and one that can is not"
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  local dir="" min_subjects=1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --min-subjects)
        [ "$#" -ge 2 ] || { echo "--min-subjects needs a number" >&2; return 2; }
        min_subjects="$2"; shift 2 ;;
      --min-subjects=*)
        min_subjects="${1#*=}"; shift ;;
      --*) echo "unknown option: $1" >&2; return 2 ;;
      *) dir="$1"; shift ;;
    esac
  done
  [ -n "$dir" ] || dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  audit "$dir" "$min_subjects"
}

main "$@"
