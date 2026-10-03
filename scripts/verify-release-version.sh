#!/usr/bin/env bash
# Assert the git tag agrees with the versions in the manifests.
#
# A tag saying v0.2.0 over a manifest saying 0.1.0 produces a release whose notes
# describe something that was not built. Nothing downstream can catch that: the
# artifact is genuinely 0.1.0, the gate is genuinely green, and the only false
# statement is the one in the most-read document the project produces.
#
# Both manifests are checked, because the CLI and the crate version independently
# and a release that ships one bumped and one not is a release that ships two
# different versions.
#
# Usage: scripts/verify-release-version.sh [tag]   (default: the current tag)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() {
  echo "::error::$1" >&2
  exit 1
}

cd "$REPO_ROOT" || fail "repo root not found"

TAG="${1:-${GITHUB_REF_NAME:-}}"
if [ -z "$TAG" ]; then
  TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
fi
[ -n "$TAG" ] || fail "no tag given and HEAD is not tagged; nothing to verify"

# A v-prefix is conventional but not required. Normalise rather than insist, so
# the check is about the NUMBER agreeing, not about a naming preference.
WANT="${TAG#v}"

CLI_VERSION="$(node -p 'require("./packages/cli/package.json").version')"
CRATE_VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' packages/rust-tui/Cargo.toml | head -1)"

echo "tag:            ${TAG} -> ${WANT}"
echo "cli version:    ${CLI_VERSION}"
echo "crate version:  ${CRATE_VERSION}"

[ "$WANT" = "$CLI_VERSION" ] \
  || fail "tag ${TAG} does not match the CLI version ${CLI_VERSION}.
A release built from this tag would ship ${CLI_VERSION} under a ${TAG} label."

[ "$WANT" = "$CRATE_VERSION" ] \
  || fail "tag ${TAG} does not match the crate version ${CRATE_VERSION}.
The two manifests are bumped independently; a release that ships one bumped and
one not ships two different versions under one name."

echo "version agreement: ok (${WANT} in both manifests)"
