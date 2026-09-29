#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/omarchy-toolchain-plan.sh [--dry-run]

Print a user-reviewed install plan for the supported security and crypto tools.
This script never installs packages, runs sudo, builds AUR packages, or executes
upstream installers.
EOF
}

if [[ $# -gt 1 || (${1-} != "" && ${1-} != "--dry-run") ]]; then
  usage >&2
  exit 2
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ ${ID-} != "arch" && ${ID_LIKE-} != *"arch"* ]]; then
    printf 'This plan is intended for Arch Linux/Omarchy; detected ID=%s.\n' "${ID-unknown}" >&2
    exit 2
  fi
else
  printf 'Cannot identify the operating system; refusing to suggest package commands.\n' >&2
  exit 2
fi

if ! command -v pacman >/dev/null 2>&1; then
  printf 'pacman is unavailable; no package plan can be checked.\n' >&2
  exit 2
fi

printf 'Dry-run only: no package installation command will be executed.\n'
printf 'Detected distribution: %s\n\n' "${PRETTY_NAME:-Arch Linux}"

official=()
for package in gitleaks trivy; do
  if pacman -Si "$package" >/dev/null 2>&1; then
    official+=("$package")
    printf 'Official repository package: %s\n' "$package"
  else
    printf 'Not found in enabled official repositories: %s\n' "$package"
  fi
done

if ((${#official[@]})); then
  printf '\nIf you choose to install these after reviewing this plan, the package command is:\n  pacman -S --needed'
  printf ' %q' "${official[@]}"
  printf '\nThis script does not run it or elevate privileges.\n'
fi

printf '\nAUR packages (review PKGBUILD/source before building):\n'
for package in solana-cli foundry-bin; do
  if pacman -Si "$package" >/dev/null 2>&1; then
    printf '  %s is available in an enabled official repository; verify its identity before use.\n' "$package"
  else
    printf '  %s is an AUR candidate; inspect PKGBUILD and source checksums before makepkg.\n' "$package"
  fi
done

printf '\nManual/upstream-managed tools (not installed by this script):\n'
printf '  Anchor/AVM: https://www.anchor-lang.com/docs/installation\n'
printf '  Solana CLI: https://solana.com/docs/intro/installation\n'
printf '  Foundry: https://book.getfoundry.sh/getting-started/installation\n'
printf '  Bandit/Slither: use an isolated Python environment such as pipx.\n'
printf '  Semgrep: follow https://semgrep.dev/docs/getting-started/; review installer before running.\n'
printf '  cargo-audit: cargo install cargo-audit (Cargo toolchain required).\n'

printf '\nNo package installation, AUR build, or upstream installer was performed.\n'
