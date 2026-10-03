# Terminal221b — Gate Register

Every gate this repository enforces, the exact command that runs it, and — for each
one — **the defect that was introduced to prove the gate goes red.**

That last column is the point of this file. A gate nobody has seen fail is a gate
assumed to work. The receipt is a command and an observed exit code, not an intention.

Re-derive the numbers here rather than trusting them; that rule is the reason the
commands are printed next to the claims.

Scope: Phase 1, the enforcement layer. The L3 agent harness is deliberately **not**
installed yet — see `FRAMEWORK.md` §6 and the sequencing note at the end.

---

## Where each gate lives

| Gate | Job in `.github/workflows/ci.yml` | Blocking? |
|---|---|---|
| `npm run lint` | `quality` | yes |
| `npm run lint:shell` | `quality` | yes |
| `npm run typecheck` | `quality` | yes |
| `npm run build:cli` | `quality` | yes |
| `npm run build` | `quality` | yes |
| `npm test` | `quality` | yes |
| executed test count ≥ 385 | `quality` | yes |
| `cargo fmt --all -- --check` | `rust` | yes |
| `cargo clippy … -D warnings` | `rust` | yes |
| `cargo test --workspace --locked` | `rust` | yes |
| `cargo build --workspace --locked` | `rust` | yes |
| `cargo deny check all` | `supply-chain` | yes |
| gitleaks | `secrets` | yes |
| CodeQL (JS-TS, Rust) | `codeql` | yes |
| `npm run typecheck:tests` | `typecheck-tests` | **no — see below** |

---

## The gates, with their red proofs

### 1. `cargo clippy --workspace --all-targets --locked -- -D warnings`

This is the gate three documents in this repository already prescribe
(`docs/TERMINAL221B-AGENTIC-ENGINEERING.md`, `docs/TERMINAL221B-ENGINEERING-GUIDE.md`,
`.github/skills/terminal221b-tui-engineering/SKILL.md`) and that no workflow ran.

```sh
cargo clippy --workspace --all-targets --locked -- -D warnings
```

**Proven red.** Planted `v.len() == 0` and a trailing `return` in
`packages/rust-tui/src/prompt.rs`:

```
error: length comparison to zero
error: items after a test module
error: could not compile `terminal221b-tui` … due to 1 previous error
exit 101
```

Reverted; the file is byte-identical to HEAD.

### 2. `cargo fmt --all -- --check`

```sh
cargo fmt --all -- --check
```

**Proven red.** Planted `fn __fmt_probe( ) ->i32{let x=1;   return   x}`:

```
Diff in …/packages/rust-tui/src/prompt.rs:157:
-fn __fmt_probe( ) ->i32{let x=1;   return   x}
+fn __fmt_probe() -> i32 {
+    let x = 1;
+    return x;
exit 1
```

Reverted; re-checked green at exit 0.

### 3. Executed test count ≥ 385

The six `it.skipIf(!HAS_BWRAP)` cases in `executor.test.ts` do nothing on a machine
without bubblewrap, and the run still exits 0. The suite's own total is therefore
environment-dependent and nothing reports the drop.

```sh
./scripts/assert-test-count.sh 385      # or: npm run test:count
```

**Proven red, twice.**

*Wrong floor* — `./scripts/assert-test-count.sh 999`:
```
executed: 385/385 tests across 87 files (floor 999)
::error::only 385 tests executed, expected at least 999.
exit 1
```

*Bubblewrap absent* — same script with `bwrap` off `PATH`:
```
::error::bubblewrap is absent, so the six it.skipIf(!HAS_BWRAP) cases in
::error::executor.test.ts would skip silently and the suite would report
::error::379 instead of 385. Install bubblewrap first.
exit 1
```

The threshold lives in CI and in this script, and deliberately **not** in
`vitest.config.ts`: a config file that judges the tests is edited by the same change
it would judge. The `quality` job installs bubblewrap so the floor is meaningful
rather than environment-dependent, and the script then asserts bubblewrap is present
so the floor cannot be satisfied by quietly skipping the six cases it exists to count.

### 4. gitleaks

```sh
gitleaks detect --no-git --source . --redact
```

**Proven red**, and the first attempt is the interesting part.

Planting the AWS documentation example key
(`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`) produced
`no leaks found`, **exit 0**. Gitleaks ships a default allowlist of well-known example
credentials, so the most obvious "fake key" proves nothing.

Re-proved with a generated `ghp_…` GitHub token and an `xoxb-…` Slack token:
```
WRN leaks found: 2
exit 1
```

**If you re-run this receipt, do not use a documented example key.** It will pass and
tell you the gate works when it has told you nothing.

### 5. `npm run typecheck:tests` — wired, deliberately non-blocking

`packages/cli/tsconfig.test.json` (roadmap 0.3) type-checks the 18 CLI test files that
`packages/cli/tsconfig.json` cannot reach, because its `include` is `["src/**/*.ts"]`
and its `rootDir` is `src`. It surfaces six real errors that no gate had ever seen:

```
dossier.test.ts(241,18)  TS2769  new Map(…) arg is (string | string[])[][], not
                                 assignable to Iterable<readonly [string, string[]]>
ranking.test.ts(4,3)     TS2459  '../src/case.js' declares 'parseBountyScope' locally,
                                 it is not exported
store.test.ts(157,7)     TS2353  'statement' does not exist in type 'AttestedRecord'
store.test.ts(259,51)    TS2339  'approvalId' does not exist on 'AttestedRecord'
store.test.ts(262,58)    TS2339  'searchId' does not exist on 'AttestedRecord'
store.test.ts(463,20)    TS2345  'AttestedRecord' missing 5 props required by
                                 'ConfirmationRecord'
exit 2
```

**It is `continue-on-error: true` on purpose.** `AttestedRecord`
(`packages/cli/src/store.ts:125`) is deliberately minimal — `{ version: 1;
attestation?: Attestation }` — with kind-specific identifiers held in a runtime
`ID_FIELD` map and reached through `as unknown as` in `recordsOfKind`. That erasure
sits directly on the provenance path (`attestationPayload`, `payloadDigestOf`,
`verifyRecord`) behind findings F4 (signature) and F5 (digest). Whether the narrowing
was deliberate hardening that the tests failed to follow, or a type narrowed past its
tests, is not decidable from the tree. That question was escalated rather than guessed.

A blocking gate that is red for a known, adjudicated reason teaches everyone to ignore
a red check, which is worse than no gate. The gate is wired and visible; it does not
block until the fork is decided. **When it is decided, delete the `continue-on-error`
line in the same commit that makes it green.**

### 6. `cargo deny check all`

```sh
cargo deny check all
```

Config is `deny.toml` at the repository root: `advisories` (unhandled advisories deny;
`unmaintained = "workspace"`), `bans` (duplicate versions warn, wildcards allowed),
`licenses` (explicit allow list, unlisted denied, not warned), `sources` (crates.io
only, unknown registry and unknown git both denied).

The `licenses` table is not hygiene here. The crate is `AGPL-3.0-only` and published to
a public repository, so a dependency under a conflicting licence is a defect in what
is redistributed.

> **Not yet proven red.** `cargo-deny` is not installed on the machine this was authored
> on, and `cargo deny check all` has never been executed against this `deny.toml`. The
> licence allow-list was written from the dependency list in
> `packages/rust-tui/Cargo.toml` (crossterm, ratatui, reqwest, serde, serde_json,
> tempfile) and not from a resolved `cargo-deny` run. **Treat the first CI run as the
> real test of this file** — expect to add a licence to the allow list on that run, and
> treat each addition as a decision to record, not a fix to make silently.

### 7. CodeQL

`javascript-typescript` and `rust`, as a matrix, with `security-events: write`.

> **Not executable locally.** CodeQL is a GitHub-hosted analysis; it produces a result
> only on a runner. Nothing about it has been observed on this machine beyond the
> workflow parsing and the action SHAs being resolved. First push is the first evidence.

---

## Action pins

Every action is pinned to a commit SHA with the tag in a trailing comment. A tag is a
mutable pointer, so a tag pin is a pin in name only. Resolved with `gh api` and peeled
from annotated tags to the commits they point at.

| Action | Tag | Commit |
|---|---|---|
| `actions/checkout` | v7 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7 | `820762786026740c76f36085b0efc47a31fe5020` |
| `dtolnay/rust-toolchain` | stable | `89b12181fb390509a0842a86cc55eeb8eb928c1d` |
| `github/codeql-action` | v3 | `1190a975f95ce23525efb6a3fc21ea29567c1b52` |
| `gitleaks/gitleaks-action` | v2 | `ff98106e4c7b2bc287b24eaf42907196329070c7` |

Re-derive:

```sh
gh api repos/actions/checkout/commits/v7 --jq .sha
```

These move only through a reviewable bump commit, like any other dependency change.

---

## Gates deliberately NOT installed yet

Recorded so their absence reads as a decision rather than an oversight.

- **`cargo-semver-checks`** — release CI only, per roadmap Phase 1 item 5. There is no
  release pipeline to attach it to yet.
- **`cargo-llvm-cov` `--fail-under-lines 70`** — Phase 3, and only on main.
- **`cargo-nextest` with `--flaky-result fail`** — Phase 3. It exists to make a
  pass-on-retry report as flaky instead of silently green; that is worth having only
  once the suite is stable enough for a flake to mean something.
- **`cargo-mutants`** — Phase 3. Budgeted, not trusted: the project self-describes as
  semi-actively maintained with one maintainer, and runtime is roughly one build plus
  one full test run per viable mutant.
- **The L3 agent harness** (six subagents, five commands, six skills, one plugin) —
  Phase 5. A judgment call this repository made about itself: agents inherit whatever
  enforcement already exists, so installing them before these gates are green
  multiplies unverified claims. That ordering was re-confirmed against the same
  question during the authoring of this file, and it is the reason this register
  exists before any agent file does.

---

## Running everything locally

```sh
npm ci
npm run lint && npm run lint:shell && npm run typecheck
npm run build:cli && npm run build
npm test
npm run test:count

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked

gitleaks detect --no-git --source . --redact
# cargo deny check all        # requires: cargo install cargo-deny --locked
```

`npm run typecheck:tests` is expected to **exit 2** until the `AttestedRecord` fork in
§5 is decided. That is the documented state, not a regression.
