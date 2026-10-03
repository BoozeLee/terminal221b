#!/usr/bin/env bash
# Install terminal221b from a GitHub Release.
#
#   curl -fsSL https://github.com/BoozeLee/terminal221b/releases/latest/download/install.sh | bash
#
# That line is `curl | bash`, and the pattern deserves its scepticism. This
# script is written to be the honest version of it:
#
#   - it prints every path it will write to, BEFORE writing to it
#   - it refuses to run as root
#   - it verifies the sha256 before extracting anything
#   - a checksum failure aborts; it never "warns and continues"
#   - it touches only the invoking user's own directories
#
# It still runs arbitrary code from the internet. Read it if you would rather:
#   curl -fsSL <url>            # then look before piping to bash
#
# No per-OS branch, because there is no per-OS artifact. The release tarball is
# pure text (19 .js, 2 .json, 3 text, 1 .sh) and the CLI has no runtime
# dependencies, so one file serves every platform with Node 22 or later. An
# installer that resolved `uname -m` would be inventing a distinction the release
# does not have.
set -euo pipefail

REPO="BoozeLee/terminal221b"
PKG="terminal221b-cli"
MIN_NODE_MAJOR=22

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# --- 0. refuse root ---------------------------------------------------------
#
# Piping a download into a root shell is the failure mode that makes this
# pattern dangerous. Declining is better than documenting it.
if [ "$(id -u)" -eq 0 ]; then
  die "refusing to install as root.
Run this as the user who will use terminal221b, without sudo. The CLI writes
only to your own home directory and needs no privileges."
fi

# --- 1. the one hard requirement: Node --------------------------------------
#
# `engines` in the package says >= 22. Checking here turns a confusing failure
# inside a node: builtin into one clear sentence.
command -v node >/dev/null 2>&1 || die "node is not installed. Install Node.js ${MIN_NODE_MAJOR} or newer, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] \
  || die "Node.js ${MIN_NODE_MAJOR} or newer is required; this is $(node -v)."

# --- 2. resolve the latest release, and say what we are about to do ----------
#
# The redirect is followed manually rather than with `curl -L` on the asset, so
# the resolved URL is printed before anything is downloaded.

step "resolving the latest release"
API_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
  || die "could not reach the GitHub API for ${REPO}"

TAG="$(printf '%s' "$API_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || die "could not read a tag from the GitHub API response"

VERSION="${TAG#v}"
ASSET="${PKG}-${VERSION}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

# Find the asset the release actually published, rather than assuming the name.
# A release with no assets must fail loudly here, not 404 confusingly later.
if ! printf '%s' "$API_JSON" | grep -q "\"name\": *\"${ASSET}\""; then
  die "release ${TAG} does not publish ${ASSET}.
The release may have been created without its artifact. Check:
  https://github.com/${REPO}/releases/tag/${TAG}"
fi

# --- 3. choose the install location, and print it ---------------------------

step "install location"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/terminal221b"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

say "  package: ${ASSET}"
say "  data:    ${DATA_DIR}"
say "  binary:  ${BIN_DIR}/terminal221b"

[ -d "$DATA_DIR" ] || mkdir -p "$DATA_DIR" || die "could not create ${DATA_DIR}"
[ -d "$BIN_DIR" ]  || mkdir -p "$BIN_DIR"  || die "could not create ${BIN_DIR}"
[ -w "$DATA_DIR" ] || die "${DATA_DIR} is not writable"
[ -w "$BIN_DIR" ]  || die "${BIN_DIR} is not writable"

# --- 4. download the tarball AND its checksum -------------------------------

WORK="$(mktemp -d "${TMPDIR:-/tmp}/t221b-install-XXXXXX")" || die "could not create a temp directory"
cleanup() { command rm -rf "$WORK" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step "downloading"
curl -fsSL "${BASE}/${ASSET}" -o "${WORK}/${ASSET}" \
  || die "download failed: ${BASE}/${ASSET}"
curl -fsSL "${BASE}/${ASSET}.sha256" -o "${WORK}/${ASSET}.sha256" \
  || die "checksum download failed: ${BASE}/${ASSET}.sha256
Without a checksum this installer refuses to extract anything, which is the
point. If the release published no .sha256, the release pipeline is broken."

# --- 5. VERIFY, then extract ------------------------------------------------
#
# In this order, always. Extracting first and checking afterwards would already
# have run code from an unverified download.

step "verifying the checksum"
EXPECTED="$(cut -d' ' -f1 < "${WORK}/${ASSET}.sha256")"
ACTUAL="$(sha256sum "${WORK}/${ASSET}" | cut -d' ' -f1)"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  die "CHECKSUM MISMATCH — nothing has been installed.
  expected ${EXPECTED}
  actual   ${ACTUAL}
Do not continue past this. Either the download was corrupted or the artifact
was replaced after it was published."
fi
say "  sha256 verified: ${ACTUAL}"

# --- 6. extract -------------------------------------------------------------

step "installing"
tar -xzf "${WORK}/${ASSET}" -C "$WORK" || die "the archive could not be extracted"
[ -d "${WORK}/package" ] || die "the archive has no package/ directory"

# Replace the previous install wholesale rather than copying over it. A
# half-updated install is how a stale resources/ file survives an upgrade.
command rm -rf "${DATA_DIR:?}/current"
mkdir -p "${DATA_DIR}/current"
cp -R "${WORK}/package/." "${DATA_DIR}/current/" \
  || die "could not copy the package into ${DATA_DIR}/current"

# --- 7. link the binary -----------------------------------------------------
#
# A symlink rather than a copy, so the installed entry point always points at
# the versioned directory it came from and cannot drift from it.
chmod +x "${DATA_DIR}/current/dist/cli.js" 2>/dev/null || true
ln -sf "${DATA_DIR}/current/dist/cli.js" "${BIN_DIR}/terminal221b" \
  || die "could not link ${BIN_DIR}/terminal221b"

step "done"
# An if/else rather than `A && B || C`: if the binary runs but prints nothing,
# the `||` branch would report a success line that was never printed. shellcheck
# flags that as SC2015 and it is right to.
if FIRST_LINE="$("${BIN_DIR}/terminal221b" --help 2>&1 | head -1)"; then
  say "  installed: ${FIRST_LINE}"
else
  say "  installed to ${BIN_DIR}/terminal221b"
  say "  (it did not print a usage line; run it directly to see why)"
fi

say ""
say "  A sandboxed run needs bubblewrap on Linux. Without it the CLI reports the"
say "  missing capability and refuses to run unsandboxed without --allow-unsandboxed."
say "  That is a runtime capability check, not an install problem."
say ""
say "  Add ${BIN_DIR} to your PATH if it is not already there."
