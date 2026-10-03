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
| executed test count ≥ 390 (384 without a sandbox) | `quality` | yes |
| `npm run test:components` (jest-expo, `*.jest.tsx`) | `quality` | yes |
| executed component test count ≥ 4, zero skipped | `quality` | yes |
| sandbox capability probe | `rust`-adjacent: exercised by `quality` and by `executor.test.ts` | yes |
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

### 3. Executed test count — capability-aware, 390 or 384

Six `it.skipIf(!sandbox)` cases in `executor.test.ts` do nothing when a sandbox
cannot be built, and the run still exits 0. The suite's own total is therefore
environment-dependent, and the six skipped cases are the *only* reason it moves.

```sh
./scripts/assert-test-count.sh 390      # or: npm run test:count
```

The floor is a function of the same capability the tests gate on, read through the
same `probeSandbox` the CLI uses, so there is one implementation rather than a bash
copy that drifts from it:

| Probe result | Floor | Why |
|---|---|---|
| `ok` | **390** | a sandbox can be built, so all six must run |
| `absent` | **384** | no bubblewrap on this host |
| `broken` | **384** | bubblewrap is here and cannot sandbox |
| any | **≥ 384** | below this, something *other* than the six skips is losing tests, and it fails under every capability |

**Proven red, twice, and green in the two states that matter.**

*Floor above the real count* — `./scripts/assert-test-count.sh 391`:
```
executed: 390/390 tests (ok: sandbox available, full floor 391)
::error::only 390 tests executed, expected at least 391.
::error::Applicable floor was 391 because the probe said 'ok'.
exit 1
```

*Broken sandbox, baseline guard* — a `bwrap` stub reproducing the runner's 0.9.0
failure, floor 391:
```
executed: 384/390 tests (broken: bubblewrap is present but cannot build a sandbox, so 6 sandbox tests were skipped)
  sandbox detail: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
::error::only 384 tests executed, below the 385 baseline
::error::that holds under every sandbox capability, so something other than
::error::the six sandbox skips is losing tests.
exit 1
```

*Broken sandbox, accounted for* — same stub, floor 390:
```
executed: 384/390 tests (broken: bubblewrap is present but cannot build a sandbox, so 6 sandbox tests were skipped)
  sandbox detail: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
note: 6 tests skipped, all of them the sandbox suite, all accounted for
exit 0
```

The gap between collected and executed is itself checked: 0 skips when the probe
says `ok`, exactly 6 when it does not, anything else fails as a silent skip nobody
accounted for.

**A note on how these proofs were produced.** Raising the *floor* above the real
count is what makes this gate red — a lower floor is satisfied by more tests, so
"pass 385 instead of 390" proves nothing. The `absent` classification is proven at
the probe (`probeSandbox('/nonexistent')` → `absent`, a unit test) rather than
end-to-end, because `execvp` continues past a PATH entry it cannot execute and
finds the real binary anyway, so shadowing bubblewrap away by `PATH` is not
possible. The `broken` path — the one the CI runner actually produces — is proven
end to end.

The threshold lives in CI and in this script, and deliberately **not** in
`vitest.config.ts`: a config file that judges the tests gets edited by the same
change it would judge. The `quality` job still installs bubblewrap, so the sandbox
suite is genuinely attempted on the runner rather than quietly skipped; where it
cannot run, the 384 floor and the printed reason say so instead of the run
reporting success over a suite that tested nothing.

### 3b. The sandbox capability probe — `probeSandbox`

`sandboxAvailable()` used to ask `bwrap --version`, which a present-but-broken
bubblewrap answers happily. The probe asks whether a real sandbox can be built, and
reports one of `ok` / `absent` / `broken`.

`broken` deliberately does **not** reach the `allowUnsandboxed` branch. A boolean
probe cannot tell `broken` from `absent`, and routing that caller to `runDirectly`
turns a security boundary into a configuration flag: before the probe, a broken
bwrap selected bubblewrap and the task failed; with a boolean probe it would run
unsandboxed. A caller who opted out of isolation on a host with no bubblewrap has
not opted out of it on a host whose bubblewrap is silently inert. So `broken`
throws, and says which of the two it is.

**Proven red.** The stub that answers `--version` with exit 0 and fails a real
sandbox returned `sandboxAvailable() === true` before this change, and
`resolveSandbox({ allowUnsandboxed: true, binary: <stub> })` returned `runDirectly`
instead of throwing. Both are now regression tests:

```
tests/executor.test.ts > the sandbox probe asks whether a sandbox can be made…
  × refuses to hand the task to the host when bubblewrap is present but broken
  AssertionError: expected [Function] to throw an error
```

Green after the change: 5 passed.

**Not memoised, deliberately.** A cached verdict is what this change exists to
remove. With a cache, a `bwrap` that demonstrably works received a cached `absent`
and a task was refused for a sandbox that was there — reproducible in the full file
and not in isolation, consistent with a second copy of the module on disk
(`packages/cli/dist/executor.js`) holding a different answer. A wrong cached verdict
on a security predicate is worse than the spawn it saves, and the spawn is once
per `resolveSandbox`: once per task run, not once per command.

The threshold lives in CI and in this script, and deliberately **not** in
`vitest.config.ts`: a config file that judges the tests is edited by the same change
it would judge. The `quality` job installs bubblewrap so the floor is meaningful
rather than environment-dependent, and the script then asserts bubblewrap is present
so the floor cannot be satisfied by quietly skipping the six cases it exists to count.

### 3c. Component render coverage — `jest-expo`, and its count floor

The 390-test suite is vitest, and vitest has no React Native preset. So
`ChatScreen` — 459 lines, the only screen, the surface a user actually touches —
was never mounted in a single test. Its store and its provider client were
covered; the thing that draws them was not. The SDK 57 upgrade is what made a
runner possible, which is why this section exists now and not three commits ago.

**Two runners, separated by filename, not by hope:**

| | globs | count floor |
|---|---|---|
| vitest | `vitest.config.ts` → `src/**/*.{test,spec}.{ts,tsx}` | §3, 390/384 |
| jest | `jest.config.js` → `src/**/*.jest.{ts,tsx}` | this section, 4 |

A component test is named `*.jest.tsx` and vitest cannot match it. Neither
number is evidence about the other suite.

**One floor here, two in §3.** That asymmetry is the interesting part. §3 has two
because six tests are `it.skipIf(!sandbox)` and genuinely execute or not
depending on the host. Nothing in this suite is capability-dependent, so a single
number is the honest one — and
`scripts/assert-component-test-count.sh` additionally **fails on any skipped
test**, so a future capability-gated component test cannot quietly reintroduce
the two-machine problem. If that check ever starts firing on a legitimate skip,
the fix is two floors here, not a deleted check.

**Every test awaits.** RNTL v14 made `render`, `fireEvent.*`, `rerender` and
`unmount` return promises. The synchronous form does not fail loudly: you get a
Promise back, `screen` is never populated, and the first assertion reports
"`render` function has not been called" — a message about the test, not the
screen. All four of these tests failed exactly that way on first run.

**Red proofs.** The floor, and the suite, each shown failing:

```
$ ./scripts/assert-component-test-count.sh 5
component tests: 4/4 executed (floor 5)
::error::only 4 component tests executed, expected at least 5.
exit 1

$ # one `it` deleted from ChatScreen.jest.tsx
component tests: 3/3 executed (floor 4)
::error::only 3 component tests executed, expected at least 4.
exit 1

$ # one `it.skip`, with a fifth test added so the floor is still satisfied
component tests: 4/5 executed (floor 4)
::error::1 component tests were skipped.
exit 1
```

And the suite itself, against real regressions rather than a deleted assertion:

```
$ # swap the two Platform.OS branches in ChatScreen.tsx
✕ opens settings and states how the API key is handled on this platform
  Unable to find an element with text: On this device, the key is stored using
  the operating system secure-storage API.
        Web builds keep the key in memory only. Do not use a live key in a web build.

$ # drop .replace('claude-', '') from the header subtitle
✕ names the product and the model when there is no session yet
  Unable to find an element with text: sonnet-4-5
          claude-sonnet-4-5
```

That first mutation is the one worth keeping. The assertion names the **native**
branch outright instead of matching `/secure-storage|memory only/`, because a
regex accepting both branches still passes when the two are swapped — and a swap
is the dangerous direction: a native build telling the user its key is held in
memory when it is being written to disk.

**Deliberately inside the `quality` job, not a new one.** A separate job buys a
second 4-minute Node + bubblewrap setup to prove four assertions. It graduates to
its own job when this suite earns it.

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

### 5. `npm run typecheck:tests` — BLOCKING, and green

`packages/cli/tsconfig.test.json` (roadmap 0.3) type-checks the 18 CLI test files that
`packages/cli/tsconfig.json` cannot reach, because its `include` is `["src/**/*.ts"]`
and its `rootDir` is `src`. It surfaced six errors that no gate had ever seen:

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

**The fork is decided: the narrowing is deliberate.** `AttestedRecord`
(`packages/cli/src/store.ts:125`) is `{ version: 1; attestation?: Attestation }`, with
kind-specific identifiers held in a runtime `ID_FIELD` map and reached through
`as unknown as` in `recordsOfKind`. That erasure sits on the provenance path
(`attestationPayload`, `payloadDigestOf`, `verifyRecord`) behind findings F4
(signature) and F5 (digest), and the comment above `attestationPayload` gives the
reason: stripping a signature must never alter what the signature commits to. The
operator confirmed the tests were at fault.

**So the tests were fixed and no production type was touched** — `be2934f`, which
modifies nothing under `packages/cli/src/`. The four AttestedRecord call sites now use
the typed bundle field for the same object, and the digest literal is annotated
`: ConfirmationRecord` because against the weak base type a fresh `statement` reads as
an excess property.

`ranking.test.ts(4,3)` was a bug, not a fork, and a worse one. It imported
`parseBountyScope` from `../src/case.js`, which does not re-export it, so it was
`undefined`; the one test using it asserted only that calling it throws, and
`TypeError: not a function` satisfies that. The test was green while exercising
nothing. Fixed in `5a5a88f`, with the proof in §8's style: the same neutered validator
that left the old test passing makes the corrected one fail.

`dossier.test.ts(241,18)` is unrelated to any of it — a Map constructor needs a tuple
and an unannotated arrow infers a union. Annotated the callback's return type.

**`npm run typecheck:tests` now exits 0 and the job is blocking.** The
`continue-on-error: true` line is gone, which was always the instruction attached to
this decision. This was the only permanently-red gate in the repository, and it was
red for the entire life of the programme.

**Proven red:**

```
$ # reference a field that does not exist on ApprovalRecord
store.test.ts(272,34): error TS2339: Property 'noSuchFieldOnApprovalRecord'
  does not exist on type 'ApprovalRecord'.
exit 2
```

The first attempt at that proof was `x as unknown as number`, which is a **legal**
double cast and therefore not a type error at all. It exited 0. A red proof that does
not go red is worse than none, so it is recorded rather than quietly replaced.

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

## 8. The seven CI steps that had no red proof

Seven steps run in `.github/workflows/ci.yml` and were in no section of this register.
They would fail if violated; nobody had seen one do it. Doctrine rule 3 asks for the
demonstration, not the capability, so this section supplies it.

All seven were red-proved against a real defect, then reverted. `git status` was
empty and each step re-run green after its revert.

| Step | Planted defect | Observed |
|---|---|---|
| `lint` | `const innerUnused = 1;` never read, in `App.tsx` | exit 1 — `'innerUnused' is assigned a value but never used. Allowed unused vars must match /^_/u` |
| `typecheck` | `const __ts_probe: number = "not a number";` in `App.tsx` | exit 2 — `App.tsx(29,7): error TS2322: Type 'string' is not assignable to type 'number'.` |
| `build:cli` | `const cliProbe: number = "wrong type";` in `packages/cli/src/cli.ts` | exit 2 — `src/cli.ts(796,7): error TS2322` |
| `build` | `require('this-module-does-not-exist')` in `App.tsx` | exit 1 — `Unable to resolve module this-module-does-not-exist` |
| `test` | `_it('deliberate red probe', () => { _expect(1).toBe(2); })` appended to `src/store/chatStore.test.ts` | exit 1 — `× deliberate red probe` |
| `cargo test` | `#[test] fn deliberate_red_probe() { assert_eq!(1, 2); }` in `packages/rust-tui/src/session.rs` | exit 101 — `test session::deliberate_red_probe ... FAILED` |
| `cargo build` | `pub fn build_probe() -> i32 { let s: String = 1; s }` in the same file | exit 101 — `error[E0308]: mismatched types` |

### Two false negatives, recorded because they nearly became false conclusions

**`lint` passed a type error and it was not the gate's fault.** The first probe named
its variable `__lint_probe`, and `eslint.config.mjs` sets
`varsIgnorePattern: '^_'`. The rule was configured to ignore exactly that name, so
the defect was correct and the gate was right to stay quiet. The corrected probe used
`innerUnused` and went red immediately. A gate that ignores `_`-prefixed names is
working as configured; a reviewer who concludes otherwise from one probe is wrong.

**`expo install --check` cannot be red-proved by editing `package.json`.** It reports
"Dependencies are up to date" even with `expo` drifted from `~57.0.26` to `~56.0.23`,
because it inspects the installed tree. See `docs/TERMINAL221B-DONE.md` §3a. It is
not in CI and is not a gate.

### Still not red-proved

§6 `cargo deny check all` and §7 CodeQL have run green in CI but have never been seen
to fail. CodeQL cannot be made to fail on demand from this machine at all. Both are
recorded as outstanding in `docs/TERMINAL221B-DONE.md` §3.

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
npm run test:components
npm run test:count:components

cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked

gitleaks detect --no-git --source . --redact
# cargo deny check all        # requires: cargo install cargo-deny --locked
```

`npm run typecheck:tests` is expected to **exit 2** until the `AttestedRecord` fork in
§5 is decided. That is the documented state, not a regression.
