#!/usr/bin/env bash
# Refuse to publish somebody's home directory.
#
# This repo is public, so anything tracked is readable by anyone. A hardcoded
# /home/<someone> is not a secret, but it is a targeting aid: it names the
# account, the machine, and the layout of both, which is exactly what a
# phishing message or a targeted intrusion starts from. The fix is to make the
# producer generic -- $HOME, %h, or a path derived from the script's own
# location -- and this is what holds the producer to that.
#
# History is deliberately left alone. Scrubbing already-published commits does
# not un-publish them, costs every signature in the repo, and adds a second
# place for the same leak to reappear. Fix forward instead.
#
# Usage:
#   check-home-paths.sh [repo-dir]   audit tracked files (default: this repo)
#   check-home-paths.sh --self-test  prove the gate can both fail and pass
#
# Placeholders are spelled so a reader -- and this gate -- can tell them apart
# from a real path at a glance:
#   /home/USER      the scrub marker left in published history
#   /home/example   a documentation or fixture example
#   /home/user      a generic example in prose
# A gate that cannot tell a placeholder from a real path is not a gate.
set -uo pipefail

DEFAULT_ALLOW='^/home/(USER|example|user)$'

# Every occurrence of a /home/<segment> in the tracked tree.
scan() {
  local dir="$1" allow="$2"
  # Tracked files only: untracked and ignored files are not published, and
  # scanning them would fail on the developer's own machine paths.
  git -C "$dir" ls-files -z |
    while IFS= read -r -d '' file; do
      [ -f "$dir/$file" ] || continue
      # Binary files cannot be read as text; a NUL byte means stop.
      if LC_ALL=C grep -qI . "$dir/$file" 2>/dev/null || [ ! -s "$dir/$file" ]; then
        LC_ALL=C grep -nIoE '/home/[A-Za-z0-9._-]+' "$dir/$file" 2>/dev/null |
          while IFS=: read -r line match; do
            printf '%s:%s:%s\n' "$file" "$line" "$match"
          done
      fi
    done |
    # Test the allowlist against the path alone. grep -nIoE prints line:path and
    # nothing else, so the reader above must take exactly two fields; reading a
    # third left it empty, the printf emitted "file:line:" with no path, and the
    # allowlist matched nothing -- so every placeholder was reported too.
    awk -F: -v allow="$allow" '$3 !~ allow'
}

# Build the allow regex from the exemption file. One absolute path per line.
# Blank lines and `#` comments are ignored, which is what .home-path-allow
# documents at its own line 7 -- it previously did not, and the comments were
# only inert because every entry is anchored. A comment shaped like an entry
# (a `#` line whose text is otherwise a well-formed path) is the case that
# matters: it must never grant an exemption, and nothing here should depend on
# the anchor to prevent that. Spelled without a literal path on purpose: this
# file is tracked, so it is scanned by itself.
build_allow() {
  local file="$1" line trimmed
  local allow="$DEFAULT_ALLOW"
  [ -f "$file" ] || { printf '%s' "$allow"; return 0; }
  # `|| [ -n "$line" ]` so a final line without a trailing newline is not dropped.
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim only to decide what to skip; compile the raw line, so no existing
    # entry changes meaning. Trimming the compiled value would silently turn a
    # padded entry from "never matches" into "matches", which loosens a gate.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    case "$trimmed" in
      ''|'#'*) continue ;;
    esac
    allow="${allow%\\\$}|^(${line})\$"
  done < "$file"
  printf '%s' "$allow"
}

# Exit 2 -- inconclusive, not clean. A gate that cannot enumerate its subjects
# must not report 0: `scan` below captures stdout only, so when `git ls-files`
# fails it yields nothing and the audit would otherwise announce a tree it never
# looked at. Absence of evidence is not evidence of absence, and in a CI log the
# two are the same line.
#
# The three cases are separated deliberately rather than folded into one test,
# because they are different mistakes and the operator needs to know which one
# they are looking at: a path that is not there, a directory that is not a
# repository, and a repository with nothing tracked in it.
refuse_to_look() {
  local dir="$1" what="$2"
  echo "$dir: inconclusive -- $what; nothing was verified, and that is not a pass" >&2
  return 2
}

preconditions() {
  local dir="$1" tracked
  [ -d "$dir" ] || refuse_to_look "$dir" "not a directory"
  [ "$?" -eq 0 ] || return 2
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 \
    || refuse_to_look "$dir" "not inside a git work tree"
  [ "$?" -eq 0 ] || return 2
  tracked="$(git -C "$dir" ls-files -z 2>/dev/null | tr -cd '\000' | wc -c)"
  [ "$tracked" -gt 0 ] \
    || refuse_to_look "$dir" "a git work tree with no tracked files, so there is nothing to scan"
  [ "$?" -eq 0 ] || return 2
  return 0
}

audit() {
  local dir="$1" allow="$2"
  local hits
  preconditions "$dir" || return 2
  hits="$(scan "$dir" "$allow")"
  if [ -n "$hits" ]; then
    echo "$dir: refusing to publish a real home directory:" >&2
    echo "$hits" | sed 's/^/  /' >&2
    echo "" >&2
    echo "  Fix the producer, not this gate: use \$HOME, systemd's %h, or a" >&2
    echo "  path derived from the script's own location. Add the path to" >&2
    echo "  .home-path-allow only if it is genuinely someone else's machine." >&2
    return 1
  fi
  echo "$dir: no real home directory in the tracked tree"
  return 0
}

self_test() {
  local tmp status failures=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # A positive control and a negative control, because a gate that passes
  # because its search was broken proves nothing.
  check() {
    local label="$1" want="$2" body="$3"
    mkdir -p "$tmp/$label"
    ( cd "$tmp/$label" && git init -q . && printf '%s\n' "$body" > tracked.txt \
      && git add tracked.txt )
    audit "$tmp/$label" "$DEFAULT_ALLOW" >/dev/null 2>&1
    status=$?
    if [ "$status" -ne "$want" ]; then
      echo "self-test FAILED: $label (wanted exit $want, got $status)" >&2
      failures=$((failures + 1))
    else
      echo "self-test ok: $label (exit $status)"
    fi
  }

  # String-level: the built regex must not contain a comment. This is the only
  # kind of control that can fail before the fix and pass after it -- the
  # filtering behaviour is identical either way, so asserting on behaviour
  # alone would prove nothing.
  allow_case() {
    local label="$1" want="$2" body="$3" got
    mkdir -p "$tmp/$label"
    printf '%s\n' "$body" > "$tmp/$label/.home-path-allow"
    got="$(build_allow "$tmp/$label/.home-path-allow")"
    if [ "$got" = "$want" ]; then
      echo "self-test ok: $label"
    else
      echo "self-test FAILED: $label" >&2
      echo "  expected: $want" >&2
      echo "  actual:   $got" >&2
      failures=$((failures + 1))
    fi
  }

  # Behaviour-level, routed through the allow file rather than around it. The
  # plain check() above calls audit() with $DEFAULT_ALLOW, which is why the
  # allow-file reader had no coverage at all.
  check_with_allow() {
    local label="$1" want="$2" allow_body="$3" body="$4" allow status
    mkdir -p "$tmp/$label"
    printf '%s\n' "$allow_body" > "$tmp/$label/.home-path-allow"
    allow="$(build_allow "$tmp/$label/.home-path-allow")"
    ( cd "$tmp/$label" && git init -q . \
      && printf '%s\n' "$body" > tracked.txt && git add tracked.txt )
    audit "$tmp/$label" "$allow" >/dev/null 2>&1
    status=$?
    if [ "$status" -ne "$want" ]; then
      echo "self-test FAILED: $label (wanted exit $want, got $status)" >&2
      failures=$((failures + 1))
    else
      echo "self-test ok: $label (exit $status)"
    fi
  }

  # The three ways a gate can look at nothing. These are the controls that make
  # the exit-2 path non-vacuous: delete `preconditions` and every one of them
  # goes red, because the audit would report a clean tree it never scanned.
  look_control() {
    local label="$1" want="$2" setup="$3" status
    mkdir -p "$tmp/$label"
    ( cd "$tmp/$label" && eval "$setup" )
    audit "$tmp/$label" "$DEFAULT_ALLOW" >/dev/null 2>&1
    status=$?
    if [ "$status" -ne "$want" ]; then
      echo "self-test FAILED: $label (wanted exit $want, got $status)" >&2
      failures=$((failures + 1))
    else
      echo "self-test ok: $label (exit $status)"
    fi
  }

  look_control unlookable-not-a-repo 2 'true'
  look_control unlookable-no-tracked-files 2 'git init -q .'

  # The third way of not looking needs no fixture at all, which is why it is
  # written out rather than folded into the helper: the subject is a path that
  # was never created. Creating a directory and then removing it would make the
  # control depend on how this host implements `rm`, which is exactly the kind of
  # incidental coupling a control must not have.
  audit "$tmp/unlookable-missing-path" "$DEFAULT_ALLOW" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "self-test FAILED: unlookable-missing-path (wanted exit 2, got $status)" >&2
    failures=$((failures + 1))
  else
    echo "self-test ok: unlookable-missing-path (exit $status)"
  fi

  # Built at runtime, not written out: once this script is tracked it is itself
  # scanned, so a literal here would make the gate fail on its own canary.
  local real_home
  real_home="$(cd ~ && pwd)"
  check canary-real-path 1 "$real_home/models/glm.gguf"
  check placeholders-only 0 '/home/USER and /home/example and /home/user'
  check real-path-beside-placeholder 1 "ok /home/USER but not $real_home"

  # The controls below name an exemption path. It has to be built at runtime,
  # not written out: this file is tracked, so the gate scans its own source and
  # would otherwise trip over a literal that only one repo's allow file lists.
  allow_case allow-comments-not-compiled \
    "${DEFAULT_ALLOW}|^(${real_home})\$" \
    "# a comment

   # an indented comment
${real_home}"

  # Fails without the skip: a whitespace-only line compiles to ^(   )$.
  allow_case allow-blank-lines-not-compiled \
    "$DEFAULT_ALLOW" \
    '# only comments


'

  # Behaviour guards: these pass before and after, and exist to catch a future
  # change to the anchoring that would make a comment-shaped line match.
  check_with_allow allow-entry-honored 0 "$real_home" "$real_home/data"
  check_with_allow allow-comment-not-honored 1 "#$real_home" "$real_home/data"

  rm -rf "$tmp"
  trap - RETURN
  if [ "$failures" -ne 0 ]; then
    echo "self-test: $failures control(s) did not behave as specified" >&2
    return 1
  fi
  echo "self-test: the gate fires on a real path and stays quiet on placeholders"
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi
  local dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  audit "$dir" "$(build_allow "$dir/.home-path-allow")"
}

main "$@"
