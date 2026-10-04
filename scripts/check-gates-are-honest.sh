#!/usr/bin/env bash
# Refuse a gate that reports a clean pass when it could not look at anything.
#
# The other gates in this repository check the repository. This one checks the
# gates, and it does so by driving them rather than by reading them, because
# reading a gate cannot tell you what it does when it is given nothing. A gate
# that reports "clean" for a repository it never scanned produces a line in a CI
# log that is indistinguishable from a gate that passed, and that is the most
# expensive kind of bug: nothing in a diff says so.
#
# The check is *differentiation*, not merely "did not exit 0". Each registered
# gate is driven against three fixtures and has to be distinguished across all
# three:
#
#   clean        exit 0   every subject was read, nothing found
#   dirty        exit 1   a subject was read and it is wrong
#   unlookable   exit 2   a subject could not be read, or there was none
#
# Requiring all three is what stops the cheap fix from being "always exit 2". A
# gate that returns 2 for everything satisfies "never reports a false green" and
# is useless; the clean fixture rejects it. A gate that returns 0 for everything
# is the bug this file exists to find; the unlookable fixture rejects it.
#
# Gates register in `.gate-manifest`, one line each:
#
#   <subject-kind> <gate-command>
#
# The subject kind selects a fixture builder. An unknown kind is a finding, not
# something to skip: it forces whoever adds a gate to answer "what does this look
# at, and what does it look like when there is nothing?", which is the question
# this file exists to make unavoidable.
#
# Usage:
#   check-gates-are-honest.sh [repo-dir]   audit the registered gates
#   check-gates-are-honest.sh --self-test prove the audit can both fail and pass
set -uo pipefail

MANIFEST_NAME='.gate-manifest'
META_NAME='check-gates-are-honest.sh'

# What each subject kind must look like in each of the three states. A builder
# writes the left column; this table is the contract those columns are held to.
#
# Built at runtime, never written out: this file is tracked and is itself scanned
# by check-home-paths.sh, so a literal path here would make that gate fail on
# this file's own canary.
real_home() { (cd ~ && pwd); }

fixture_clean_git_tree() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d" && git init -q . && printf 'nothing here\n' > clean.txt && git add clean.txt )
}

fixture_dirty_git_tree() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d" && git init -q . && printf 'weights at %s/models\n' "$(real_home)" > leak.txt \
    && git add leak.txt )
}

fixture_unlookable_git_tree() {
  local d="$1"
  mkdir -p "$d"
  ( cd "$d" && git init -q . )
}

# A sound workflow: a job with a real step that can fail.
_workflow_sound() {
  cat <<'YAML'
name: Gates
on:
  push:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - run: ./scripts/run-something-real
YAML
}

# A workflow whose only job fetches the code and does nothing with it.
_workflow_vacuous() {
  cat <<'YAML'
name: Gates
on:
  push:
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
YAML
}

fixture_clean_workflow_dir() {
  local d="$1"
  mkdir -p "$d/.github/workflows"
  _workflow_sound > "$d/.github/workflows/w.yml"
}

fixture_dirty_workflow_dir() {
  local d="$1"
  mkdir -p "$d/.github/workflows"
  _workflow_vacuous > "$d/.github/workflows/w.yml"
}

fixture_unlookable_workflow_dir() {
  # No .github/workflows at all. This is the shape the whole effort exists to
  # catch: a repository with no CI is not a repository that is fine.
  mkdir -p "$1"
}

# Run a gate against one fixture and echo its exit code. The gate's own stdout
# and stderr are discarded: this file judges the exit code, and printing a
# gate's findings here would be reporting a second opinion it never asked for.
run_gate() {
  local gate="$1" dir="$2"
  "$gate" "$dir" >/dev/null 2>&1
  echo $?
}

# Echo the three fixture builders for a kind, or nothing if the kind is unknown.
builders_for() {
  case "$1" in
    git-tree)
      echo "fixture_clean_git_tree fixture_dirty_git_tree fixture_unlookable_git_tree" ;;
    workflow-dir)
      echo "fixture_clean_workflow_dir fixture_dirty_workflow_dir fixture_unlookable_workflow_dir" ;;
    *) return 1 ;;
  esac
}

# Explain one observed triple. Kept separate from the comparison so the report
# says what was wrong rather than only that something was.
verdict() {
  local name="$1" c="$2" d="$3" u="$4"
  if [ "$c" -eq 0 ] && [ "$d" -eq 1 ] && [ "$u" -eq 2 ]; then
    return 0
  fi
  if [ "$u" -ne 2 ]; then
    printf '%s: given a subject it cannot look at, it reported exit %s, not 2 -- this gate can report a clean pass having verified nothing\n' \
      "$name" "$u"
  fi
  if [ "$c" -ne 0 ]; then
    printf '%s: given a clean subject it reported exit %s, not 0 -- it refuses a tree that is fine\n' \
      "$name" "$c"
  fi
  if [ "$d" -ne 1 ]; then
    printf '%s: given a subject with a real problem it reported exit %s, not 1 -- it cannot tell a finding from a pass\n' \
      "$name" "$d"
  fi
  return 1
}

audit() {
  local dir="${1:-.}" manifest="$1/.gate-manifest"
  manifest="$dir/$MANIFEST_NAME"
  local tmp status problems=0 checked=0
  local -a findings=() gates=()

  if [ ! -f "$manifest" ]; then
    echo "$dir: inconclusive -- no $MANIFEST_NAME, so no gate is registered and" \
      "none was audited" >&2
    return 2
  fi
  if [ ! -d "$dir/scripts" ]; then
    echo "$dir: inconclusive -- no scripts directory to find the gates in" >&2
    return 2
  fi

  tmp="$(mktemp -d)"
  # Double-quoted on purpose. A single-quoted RETURN trap body is expanded when
  # the trap fires, and a RETURN trap is a single global slot that any function
  # may overwrite -- so it can fire at a *caller's* return, where `$tmp` is that
  # caller's directory. Interpolating now means this trap can only ever remove
  # the directory this function created.
  trap "rm -rf '$tmp'" RETURN

  local line kind gate builders cb db ub base c d u
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    kind="${line%%[[:space:]]*}"
    gate="${line#"$kind"}"
    gate="${gate#"${gate%%[![:space:]]*}"}"
    [ -n "$gate" ] || continue
    checked=$((checked + 1))
    gates+=("$gate")

    if ! builders="$(builders_for "$kind")"; then
      findings+=("$gate: subject kind '$kind' has no fixture builder -- a gate whose subject cannot be made empty has not been audited")
      problems=$((problems + 1))
      continue
    fi
    if [ ! -x "$dir/$gate" ]; then
      findings+=("$gate: registered in $MANIFEST_NAME but not present and executable at that path")
      problems=$((problems + 1))
      continue
    fi

    set -- $builders
    cb="$1"; db="$2"; ub="$3"
    base="$tmp/$(printf '%s' "$gate" | tr -c 'A-Za-z0-9._-' '_')"
    "$cb" "$base/clean"
    "$db" "$base/dirty"
    "$ub" "$base/unlookable"

    c="$(run_gate "$dir/$gate" "$base/clean")"
    d="$(run_gate "$dir/$gate" "$base/dirty")"
    u="$(run_gate "$dir/$gate" "$base/unlookable")"

    if ! verdict "$gate" "$c" "$d" "$u"; then
      problems=$((problems + 1))
      findings+=("$(verdict "$gate" "$c" "$d" "$u" 2>/dev/null | head -3)")
    fi
  done < "$manifest"

  # A gate that verify-gates.sh runs but that nobody registered here is being
  # executed with no audit of whether it can fail. The manifest is the only
  # record of which gates matter, so a gate that falls out of it while still
  # being run is a silent loss of exactly the thing this file exists to provide.
  local runner="$dir/scripts/verify-gates.sh"
  if [ ! -f "$runner" ]; then
    echo "$dir: inconclusive -- no scripts/verify-gates.sh, so nothing records which" \
      "gates are meant to run" >&2
    return 2
  fi
  if ! grep -q 'scripts/check-gates-are-honest.sh --self-test' "$runner"; then
    findings+=("scripts/verify-gates.sh does not run this gate's self-test, so its judgement is never checked")
    problems=$((problems + 1))
  fi
  local entry
  for entry in "${gates[@]}"; do
    if ! grep -qF "$entry" "$runner"; then
      findings+=("$entry is registered here but scripts/verify-gates.sh never runs it")
      problems=$((problems + 1))
    fi
  done

  # The other direction, which is the one that actually bites. A gate can be
  # running in verify-gates.sh and still fall out of the manifest, and then
  # nothing has ever checked whether it can fail -- it is executed, and its
  # opinion is believed, and no one has asked whether that opinion means
  # anything. Reading the runner rather than the manifest is what catches it.
  #
  # This gate is exempt from the requirement: it is the auditor, and auditing
  # itself would be circular.
  local invoked_path
  while IFS= read -r invoked_path; do
    [ -n "$invoked_path" ] || continue
    [ "$invoked_path" = "scripts/$META_NAME" ] && continue
    if ! printf '%s\n' "${gates[@]}" | grep -qxF "$invoked_path"; then
      findings+=("$invoked_path is run by scripts/verify-gates.sh but is not registered in $MANIFEST_NAME, so nothing has checked whether it can fail")
      problems=$((problems + 1))
    fi
    # Read the array's entries, not every mention of a path in the file. The
    # header comment talks about this script by name, and a grep that counted
    # that would demand the runner be registered as a gate in itself.
  done <<< "$(grep -oE '^[[:space:]]*"scripts/[A-Za-z0-9._-]+\.sh' "$runner" \
             | grep -oE 'scripts/[A-Za-z0-9._-]+\.sh' | sort -u)"

  # And the entry point CI calls has to be the one that runs all of this.
  local wf="$dir/.github/workflows/gates.yml"
  if [ ! -f "$wf" ]; then
    findings+=("no .github/workflows/gates.yml, so nothing in CI runs any of this")
    problems=$((problems + 1))
  # Both spellings are ordinary YAML and both are common: `run:` on its own line
  # under `- name:`, and the inline `- run:` form. Matching only one of them
  # would let a perfectly wired repository report that nothing runs its gates.
  elif ! grep -qE '^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*\./scripts/verify-gates\.sh[[:space:]]*$' "$wf"; then
    findings+=(".github/workflows/gates.yml does not run ./scripts/verify-gates.sh, so the gates are not in CI")
    problems=$((problems + 1))
  fi

  if [ "$checked" -eq 0 ]; then
    echo "$dir: inconclusive -- $MANIFEST_NAME lists no gates, so none was audited" >&2
    return 2
  fi

  if [ "$problems" -ne 0 ]; then
    echo "$dir: ${problems} of ${checked} registered gate(s) are not honest about" \
      "what they verified:" >&2
    for f in "${findings[@]}"; do echo "  $f" >&2; done
    echo "" >&2
    echo "  A gate must distinguish: 0 clean, 1 findings, 2 inconclusive." >&2
    return 1
  fi
  echo "$dir: ${checked} registered gate(s), each distinguishing clean, findings and inconclusive"
  return 0
}

self_test() {
  local tmp status failures=0
  tmp="$(mktemp -d)"
  trap "rm -rf '$tmp'" RETURN

  # One synthetic repository, several gates of known honesty, and a manifest
  # naming them. The dishonest fixtures are the interesting half: a gate that
  # cannot tell "clean" from "could not look" must be reported, and the two that
  # are broken in the *opposite* directions must be reported too, or this file
  # would accept a gate that had been "fixed" by making it fail at everything.
  #
  # These are copies written into a temp directory, never references to the live
  # scripts, so the control keeps testing this file's judgement after the real
  # gates are fixed.
  local repo="$tmp/repo"
  mkdir -p "$repo/scripts"

  # Honest: distinguishes all three.
  cat > "$repo/scripts/honest-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -uo pipefail
dir="${1:-.}"
[ -d "$dir" ] || exit 2
if [ -f "$dir/leak.txt" ]; then
  echo "found it" >&2
  exit 1
fi
[ -f "$dir/clean.txt" ] || exit 2
echo "clean"
GATE

  # Dishonest in the way that started all this: reports a pass for a tree it
  # never looked at.
  cat > "$repo/scripts/always-clean-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -uo pipefail
exit 0
GATE

  # Dishonest in the opposite direction, and the one a careless fix produces.
  cat > "$repo/scripts/always-two-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -uo pipefail
exit 2
GATE

  # The shape that actually shipped, in miniature: right about a real finding,
  # right about a clean tree, and silently wrong about everything it could not
  # read. This is the specific defect the whole effort is about, and it is worth
  # its own control rather than relying on the always-passes one above, because
  # that gate is wrong in every direction and this one is wrong in only the one
  # that looks like a pass in a CI log.
  cat > "$repo/scripts/fix-after-the-fact-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -uo pipefail
dir="${1:-.}"
if [ -f "$dir/leak.txt" ]; then
  exit 1
fi
exit 0
GATE

  # Half-honest: gets the unlookable case right, calls everything else a finding.
  cat > "$repo/scripts/only-refuses-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -uo pipefail
dir="${1:-.}"
[ -d "$dir" ] || exit 2
[ -f "$dir/clean.txt" ] || exit 1
exit 0
GATE

  chmod +x "$repo"/scripts/*.sh
  # The wiring check below looks for these, so a synthetic repo has to have them
  # or every control would be reporting the missing wiring instead of the gate
  # under test.
  mkdir -p "$repo/.github/workflows"
  write_wiring honest-gate.sh
  cat > "$repo/.github/workflows/gates.yml" <<'WIRING'
name: Gates
on:
  push:
jobs:
  gates:
    runs-on: ubuntu-24.04
    steps:
      - run: ./scripts/verify-gates.sh
WIRING

  # A manifest naming one gate, so each control isolates exactly one judgement.
  # Each control names exactly one gate in the manifest *and* rewrites the
  # synthetic runner to invoke only that gate, so a control is isolated on both
  # dimensions. Registering one gate while the runner lists six would make every
  # control report the wiring mismatch instead of the gate's own behaviour, and
  # a control that always reports the same thing is not a control.
  write_wiring() {
    cat > "$repo/scripts/verify-gates.sh" <<WIRING
#!/usr/bin/env bash
gate_cmds=(
  "scripts/$META_NAME --self-test"
  "scripts/$1"
)
WIRING
  }

  gate_control() {
    local label="$1" want="$2" gate="$3"
    printf 'git-tree scripts/%s\n' "$gate" > "$repo/$MANIFEST_NAME"
    write_wiring "$gate"
    audit "$repo" >/dev/null 2>&1
    status=$?
    if [ "$status" -ne "$want" ]; then
      echo "self-test FAILED: $label (wanted exit $want, got $status)" >&2
      failures=$((failures + 1))
    else
      echo "self-test ok: $label (exit $status)"
    fi
  }

  gate_control accepts-an-honest-gate 0 honest-gate.sh
  gate_control refuses-the-shape-that-shipped 1 fix-after-the-fact-gate.sh
  gate_control refuses-a-gate-that-always-passes 1 always-clean-gate.sh
  gate_control refuses-a-gate-that-always-refuses 1 always-two-gate.sh
  gate_control refuses-a-gate-that-only-refuses 1 only-refuses-gate.sh

  # A manifest naming a gate that is not there: a registration that silently
  # stops being checked is the same failure as a gate that stops running.
  printf 'git-tree scripts/not-installed.sh\n' > "$repo/$MANIFEST_NAME"
  audit "$repo" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "self-test FAILED: refuses-a-missing-gate (wanted exit 1, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-a-missing-gate (exit $status)"
  fi

  # The direction that actually bites in practice: a gate that is still being run
  # but has fallen out of the manifest. Its output is still believed, and nothing
  # has ever asked whether it can distinguish a pass from a blank.
  printf 'git-tree scripts/honest-gate.sh\n' > "$repo/$MANIFEST_NAME"
  printf 'git-tree scripts/never-registered-gate.sh\n' \
    >> "$repo/scripts/verify-gates.sh"
  cat > "$repo/scripts/never-registered-gate.sh" <<'GATE'
#!/usr/bin/env bash
exit 0
GATE
  chmod +x "$repo/scripts/never-registered-gate.sh"
  audit "$repo" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "self-test FAILED: refuses-a-run-but-unregistered-gate (wanted exit 1, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-a-run-but-unregistered-gate (exit $status)"
  fi
  # Put the runner back, or every later control inherits the finding. The gate
  # file itself needs no cleanup: it lives under $tmp, which the RETURN trap
  # removes on the way out.
  write_wiring honest-gate.sh

  # An unknown subject kind is a finding, not a skip.
  printf 'some-new-kind scripts/honest-gate.sh\n' > "$repo/$MANIFEST_NAME"
  audit "$repo" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 1 ]; then
    echo "self-test FAILED: refuses-an-unknown-subject-kind (wanted exit 1, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-an-unknown-subject-kind (exit $status)"
  fi

  # No manifest at all is inconclusive, not a pass: nothing was audited.
  local bare="$tmp/bare"
  mkdir -p "$bare"
  audit "$bare" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "self-test FAILED: refuses-a-repo-with-no-manifest (wanted exit 2, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-a-repo-with-no-manifest (exit $status)"
  fi

  # The manifest exists but names nothing: a clean-looking pass that audited
  # zero gates is the exact bug, one level up.
  mkdir -p "$bare/scripts"
  printf '# nothing registered\n' > "$bare/$MANIFEST_NAME"
  audit "$bare" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "self-test FAILED: refuses-an-empty-manifest (wanted exit 2, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: refuses-an-empty-manifest (exit $status)"
  fi

  rm -rf "$tmp"
  trap - RETURN
  if [ "$failures" -ne 0 ]; then
    echo "self-test: $failures control(s) did not behave as specified" >&2
    return 1
  fi
  echo "self-test: an honest gate is accepted, and every dishonest one is named"
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  audit "${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
}

main "$@"
