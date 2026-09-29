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
for package in gitleaks trivy cargo-audit; do
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
if pacman -Si solana-cli >/dev/null 2>&1; then
  printf '  solana-cli is available in an enabled official repository; verify its identity before use.\n'
else
  printf '  solana-cli is an AUR candidate; inspect PKGBUILD and source checksums before makepkg.\n'
fi

printf '\nManual/upstream-managed tools (not installed by this script):\n'
printf '  Foundry: use the official installer at https://getfoundry.sh/install (release hashes are verified).\n'
printf '  Slither: install in an isolated environment, e.g. pipx install slither-analyzer.\n'
printf '  Solidity compiler: pipx install solc-select, then select a compiler version for the project.\n'
printf '  Semgrep: install in an isolated environment, e.g. pipx install semgrep.\n'
printf '  Anchor/AVM: https://www.anchor-lang.com/docs/installation\n'
printf '  Solana CLI: https://solana.com/docs/intro/installation\n'
printf '  Bandit: install in an isolated environment, e.g. pipx install bandit.\n'

printf '\nNo package installation, AUR build, or upstream installer was performed.\n'
