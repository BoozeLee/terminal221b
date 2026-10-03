---
name: terminal221b-supply-chain
description: Manage Terminal221b's dependency provenance, licence compliance, and secret scanning. Use when touching deny.toml, Cargo.lock, package-lock.json, dependabot, the supply-chain or secrets CI jobs, npm provenance, or any dependency bump. The crate is AGPL-3.0-only and public, so dependency licences determine what may legally be redistributed.
---

# Terminal221b supply chain

## Why this is its own skill

This repository is `AGPL-3.0-only` and published to a public remote. Dependency
licences are therefore not hygiene — they determine what may lawfully be
redistributed. A dependency under a conflicting licence is a defect in the product,
not a style note. `deny.toml` exists to make that question answerable instead of
assumed.

## Source of truth

- `deny.toml` — advisories, bans, licenses, sources.
- `.github/workflows/ci.yml` — the `supply-chain` and `secrets` jobs.
- `.github/dependabot.yml` — update schedules.
- `docs/TERMINAL221B-GATES.md` — the gate register.
- `SECURITY.md` — what the app discloses about key handling.

Read the files. Do not rely on this summary where they disagree.

## Known state, and what is not yet true

- **`deny.toml` has never been executed.** `cargo-deny` was not installed on the
  machine it was written on, so the licence allow list was composed from the
  dependency list in `packages/rust-tui/Cargo.toml`, not from a resolved run.
  **The first `cargo deny check all` is the real test of that file.** Expect to add
  a licence on that run, and treat each addition as a decision to record in the
  commit message — not a fix to make silently.
- **`sources` allows crates.io only.** `unknown-registry` and `unknown-git` are both
  `deny`. A dependency fetched from an arbitrary git URL is a dependency nobody
  reviewed.
- **`bans.multiple-versions` is `warn`, `wildcards` is `allow`.** Duplicate versions
  in a tree this size are normal and are not by themselves a finding.

## dependabot: a real, verified gap

`.github/dependabot.yml` already exists and covers `github-actions` and `npm`,
weekly. It does **not** cover `cargo`. The Rust crate's dependencies — `reqwest`,
`ratatui`, `crossterm` — therefore receive no automated update, while the TypeScript
half does. Adding the `cargo` ecosystem is a small, self-contained fix.

A related gap is open right now: the branch is **2 commits behind `public/main`**, and
both are dependency security (`4576664 fix(deps): remediate npm audit findings, drop
both criticals` and `2c2e08c fix(deps): pin postcss, image-size and uuid via npm
overrides`). Reconciling that divergence is a decision, not a mechanical step.

## Rules

1. Do not add a licence to the allow list without saying why in the commit message.
   The list is the statement of what this AGPL project may redistribute.
2. `advisories.ignore` is empty. Do not populate it casually. A blanket ignore is
   the shape unmaintained code accumulates behind; if one is needed, it gets its own
   commit with its own rationale.
3. `advisories.unmaintained` is `"workspace"` — workspace members only. Widening it
   to `"all"` would fire on most of a transitive tree and be ignored, which is the
   same failure as an unignored warning.
4. Never add a dependency to fix a small problem. The TUI, the CLI, and the app each
   have a deliberately small dependency surface.
5. If dependencies changed, update and verify the lockfile (`Cargo.lock`,
   `package-lock.json`); otherwise leave them untouched.

## Proving the secrets gate

The `secrets` job runs `gitleaks/gitleaks-action`, which scans **git history**, with
`fetch-depth: 0` so a shallow clone cannot silently reduce the gate to one commit.

**Local and CI do not scan the same thing, and that trips people up.** A bare
`gitleaks detect --source .` on a developer machine reports **36 findings across 4
commits** in this repository. None of them are reachable from `public/main` or from
the branch that CI scans:

| Commit | Subject | Reachable from `public/main`? |
|---|---|---|
| `35f759d` | Terminal221B PAO — complete agent implementation | no |
| `7c41200` | Wire up real API integrations | no |
| `8f52637` | Fix Groovy dependencies — remove Slf4j | no |
| `e1749a3` | `[#9150][feat] AutoDeploy Nemotron-Flash` | no |

They live only in a **stale local remote-tracking ref**, `archive/main`. `archive`
and `public` are the same URL, so that ref points at history the public repository
does not contain — and its commits are visibly from a different project (Groovy
build files, Maven-style PR numbering). Scoped to this branch, the history is clean:

```sh
gitleaks git --log-opts="HEAD" --redact .     # 53 commits, no leaks, exit 0
```

**So there is no exposure, and the reason is worth knowing before chasing it.** Do
not rewrite history and do not allowlist these — an allowlist entry says "this named
value is not a secret", and the honest answer for off-branch history is that it is
not ours to scan, not that it is safe. If you want the local scan to match CI, scope
it with `--log-opts`.

**When proving this gate can go red, do not use a documented example credential.**
Planting `AKIAIOSFODNN7EXAMPLE` with the well-known example secret produces
`no leaks found`, exit 0 — gitleaks ships a default allowlist of exactly those
example values. The gate then looks proven and has proved nothing. Use a generated
value instead:

```sh
printf 'GITHUB_TOKEN=ghp_%s\n' "$(head -c 36 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 36)" > __leak_probe.txt
gitleaks detect --no-git --source . --redact   # expect: leaks found, exit 1
rm -f __leak_probe.txt
gitleaks detect --no-git --source . --redact   # expect: no leaks, exit 0
```

## Commands

```sh
cargo deny check all                            # requires: cargo install cargo-deny --locked
gitleaks detect --no-git --source . --redact
```

```sh
# Both in CI: the `supply-chain` and `secrets` jobs of .github/workflows/ci.yml.
# A gate never shown to go red is assumed working, not known working.
```

## Publishing and provenance

- **`cargo publish --provenance` does not exist.** Do not write a release procedure
  that calls it. Provenance for Rust comes from GitHub attestations or cosign.
- npm provenance requires all four of: `permissions: id-token: write`, a
  **cloud-hosted** runner, npm CLI ≥ 9.5.0, and `package-manager-cache: false` in
  the release build. All four, or the attestation fails.
- Do not push, publish, tag, or change repository settings unless explicitly asked.
