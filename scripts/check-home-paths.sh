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

audit() {
  local dir="$1" allow="$2"
  local hits
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

  # Built at runtime, not written out: once this script is tracked it is itself
  # scanned, so a literal here would make the gate fail on its own canary.
  local real_home
  real_home="$(cd ~ && pwd)"
  check canary-real-path 1 "$real_home/models/glm.gguf"
  check placeholders-only 0 '/home/USER and /home/example and /home/user'
  check real-path-beside-placeholder 1 "ok /home/USER but not $real_home"

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
  local allow="$DEFAULT_ALLOW"
  # A repo may extend the list for paths that are genuinely not the author's.
  if [ -f "$dir/.home-path-allow" ]; then
    allow="$DEFAULT_ALLOW"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      allow="${allow%\\\$}|^(${line})\$"
    done < "$dir/.home-path-allow"
  fi
  audit "$dir" "$allow"
}

main "$@"
