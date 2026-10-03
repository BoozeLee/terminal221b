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

**Two things about this gate that its green status does not tell you.** Both were
found by reading the log rather than the job list, and the first one is a correction
of an earlier claim in this file.

**No licence key is needed here, and an earlier version of this section said
otherwise. It was wrong.** The action's own output on a passing run says
`[BoozeLee] is an individual user. No license key is required.`, and the upstream
README states `GITLEAKS_LICENSE` is "required for organizations, not required for user
accounts". The repository owner is a personal account:

```sh
gh api repos/BoozeLee/terminal221b --jq '.owner.type'   # User
gh secret list --repo BoozeLee/terminal221b             # empty — and correctly so
```

**So the false red on run `37105740571` was not a missing licence.** It was a rate
limit hitting the exemption lookup:

```
##[warning] Get user [BoozeLee] failed with error [HttpError: API rate limit exceeded
for 172.182.195.177. …]. License key validation will be enforced.
##[error] 🛑 missing gitleaks license.
```

No scan ran, and the failure has nothing to do with secrets. Run `37106340241` passed
genuinely — `3 commits scanned`, `no leaks found`. The job list cannot tell those two
apart, so **check the log for `commits scanned` before believing a green here.** A
gate that is randomly red for reasons unrelated to its purpose is as corrosive as one
that is permanently red: both teach people to re-run instead of read.

**The pin WAS v2.3.9, and v2 is past its deprecation date.** Verified, not assumed.
(The v2 line is kept as history; the live pin is v3.0.0, two blocks below.)

```sh
gh api repos/gitleaks/gitleaks-action/git/ref/tags/v2.3.9 --jq '.object.sha'
# ff98106e4c7b2bc287b24eaf42907196329070c7  <- the pin until 2026-10-03
gh api repos/gitleaks/gitleaks-action/git/ref/tags/v3.0.0 --jq '.object.sha'
# e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e
```

Upstream: v2 runs on Node 20, which GitHub removed from hosted runners on
**2026-09-16**, and "gitleaks-action@v2 will stop working regardless of any opt-out
flag". v3 moves to Node 24 and requires a runner at v2.327.1 or newer. `actions/checkout`
is already pinned at v7 here, which is past the v6 that v3 asks for, so the migration is
the one-line action swap and nothing else.

**DONE 2026-10-03 — migrated to v3.0.0** (`e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`).
v3 moves the action to Node 24, so it is off the removed-Node-20 line entirely.
`actions/checkout` was already at v7, past the v6 v3 asks for, so the migration was the
one-line action swap and nothing else. Re-derive both pins:

```sh
gh api repos/gitleaks/gitleaks-action/git/ref/tags/v3.0.0 --jq '.object.sha'
# e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e
```

The `commits scanned` check above is now a **required** part of accepting a green gitleaks
run, not a nicety: v2 failed closed on a rate-limited lookup, and a v3 regression of the
same kind would again present as `[success]` in the job list.

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

### 9. TypeScript line coverage — `npx vitest run --coverage`, floor 75

**75.68% lines (1466/1937), measured 2026-10-03.**

```sh
npx vitest run --coverage
```

The floor lives in `vitest.config.ts`, not in CI, for the reason §3 gives: a config file
that judges the tests is edited by the same change it would judge. The CI step only runs
the command; the threshold and the `include` both come from the config, and neither is
restated on the command line, because a flag there would silently outrank the config if
one of the two were ever edited alone.

**The floor is 75, not 75.68.** This box runs Node 24; CI runs Node 22. A threshold
pinned to a measured float would go red for a reason that has nothing to do with the
code, which is the permanently-red-gate failure this file exists to prevent. It is still
a ratchet: it passes today and any real drop fails, as the second red proof shows.

**That margin was not caution, it was necessary — and the first CI run proved it:**

| Host | Node | Lines |
|---|---|---|
| this box | 24.21.0 | 75.68% |
| CI, run `37109282889` | 22 | **75.27%** |

A 0.41-point spread between two machines, from one commit and one test suite. A floor
set at 75.68 — which is what "the floor is the measured number" produces on its own —
would have failed on CI's very first run, for a reason that has nothing to do with the
code. Re-derive the CI figure from that job's log rather than trusting this table.

The Rust figure shows no such spread: `cargo llvm-cov` reported **65.96%** on both this
box and CI, because the Rust toolchain does not change with the Node version. If a
future TypeScript run drifts more than 0.73 points, the floor needs raising
deliberately, and this paragraph is where that should be noticed.

**Scope is `packages/cli/src` and deliberately not `src/`.** The app is covered by two
runners. vitest runs `src/services/api/ClaudeService.test.ts` and
`src/store/chatStore.test.ts`; `src/screens/Chat/ChatScreen.tsx` is rendered only by jest
through `src/**/*.jest.{ts,tsx}`, which vitest's globs cannot match. Covering `src/**`
would report `ChatScreen.tsx` as uncovered — a runner artefact, not a coverage gap — and
a floor computed over it would be measuring the wrong thing. **The app's coverage is not
in this number**, and pretending otherwise is the specific error this scope prevents.

**Proven red, twice, and the first one raises the floor:**

```
$ # floor raised to 90, above the measurement
ERROR: Coverage for lines (75.68%) does not meet global threshold (90%)
exit 1

$ # 18 lines of unreachable code planted in packages/cli/src/coverage-probe.ts
Lines : 74.98% ( 1466/1955 )
ERROR: Coverage for lines (74.98%) does not meet global threshold (75%)
exit 1
```

The second proof is the one that matters: the numerator held at 1466 while the
denominator grew from 1937 to 1955, so the gate is tracking real code rather than
reporting a constant. It also shows the 0.68-point margin is small enough that 18
uncovered lines trip it.

**A configuration mistake that would have made this gate lie.** The `coverage` block was
first written at the top level of `defineConfig`, beside `test`, where **Vitest silently
ignores it**. The suite then reported **90.20%** instead of 75.68% — not because
coverage improved, but because the `include` never applied and the 794-line
`packages/cli/src/cli.ts` dropped out of the denominator. A coverage gate that reports a
better number when it measures less is worse than no gate, and this one would have passed
while hiding the repository's largest untested file. `coverage` belongs **under `test`**,
and `cli.ts` sitting at 0% in the table is the evidence that it is being counted.

**Known shape of the number.** `packages/cli/src/cli.ts` (794 lines, the binary entry
point, imported by no test) and `provider.ts` are both at 0%. That is 845 of 1937 lines —
44% of the measured surface with no test at all. The 75.68% is carried by the other
thirteen files, most of which are above 90%. This is the honest starting point, not a
result to be proud of, and it is the obvious next target.

Branch (64.97%) and functions (84.69%) are reported by the same command and **not gated**.
A gate is only worth having if someone collects the number it needs.

### 10. Rust line coverage — `cargo llvm-cov`, floor 65

**65.96% lines (1692/2565), measured 2026-10-03.**

```sh
cargo llvm-cov --workspace --locked --fail-under-lines 65
```

Per file, lines:

| File | Lines | Notes |
|---|---|---|
| `boundary_drift.rs` | 96.91% | |
| `workspace.rs` | 96.45% | |
| `dossier.rs` | 88.61% | |
| `boundary.rs` | 85.38% | |
| `session.rs` | 83.59% | |
| `prompt.rs` | 80.60% | |
| **`main.rs`** | **34.39%** | 683 of 1041 lines unexecuted |

**The roadmap's `--fail-under-lines 70` is discarded, not adopted.** The crate is
binary-only (`[[bin]]`, no `[lib]`), so `main()`, `run()` and most of `impl App` are
unreachable by the 60 tests, and `main.rs` drags the total to 65.96%. A 70 floor would
have been red on the day it landed — doctrine rule 2, a gate that trains everyone to
ignore it. The floor is 65, a whole number below the measurement, for the reason §9
gives: this box is not the CI machine, and a float threshold would go red for a reason
unrelated to the code.

Note what is *not* the problem: `validate_patch`, the security-relevant path-traversal
guard at `packages/rust-tui/src/main.rs:266`, has five tests covering traversal, symlink
destinations, secrets, and quoted paths. The crate is unevenly reachable, not untested.

**Proven red, and the first one raises the floor:**

```
$ # floor raised to 66, one point above the measurement
exit 1
$ # floor at 65
exit 0
```

`cargo llvm-cov --fail-under-lines` **exits non-zero and prints nothing explaining
why**. The CI step's `|| { echo "::error::Rust line coverage is below 65" }` is
therefore the only human-readable signal, and it is not decoration.

```
$ # 51 lines of unreachable code planted in main.rs, then reverted
TOTAL  4333 regions  1436 missed  66.86%   2611 lines  919 missed  64.80%
exit 1
$ # reverted
TOTAL  4207 regions  1310 missed  68.86%   2565 lines  873 missed  65.96%
exit 0
```

The denominator grew from 2565 to 2611 while the covered count held, so the gate
tracks real code. A first attempt planted only 17 lines and moved the number to
65.68% without crossing the floor — the drop was real but the gate did not fire, so
the plant was enlarged rather than the proof declared finished on a number that moved.

Installed with `cargo install cargo-llvm-cov --version 0.9.1 --locked`, mirroring the
`cargo install cargo-deny --locked` the `supply-chain` job already runs. That adds no
third-party action and leaves the every-action-pinned-to-a-SHA rule intact. Cost is
~70 seconds of build on every run; the faster alternative is a new trust dependency.
`llvm-tools-preview` was added to the `dtolnay/rust-toolchain` step, which the tool
requires.

**Doctests: a planned step that could not be built, and why.** Phase 3 specified a
`cargo test --doc --workspace --locked` step to guard against the silent case where a
future `///` example is added and neither `cargo test` nor `cargo llvm-cov` runs it.
It does not work on this crate:

```
$ cargo test --doc --workspace --locked
error: no library targets found in package `terminal221b-tui`
exit 101
```

Doctests only exist for **library** targets, and this package has none. Committed as
written, that step would be permanently red for a structural reason — the exact failure
this file exists to prevent — so it is **not** in CI.

The gap the plan worried about turns out to be structurally closed rather than merely
unguarded: a `///` example in a binary-only crate is not compiled as a doctest at all,
so nothing can be silently skipped. Opening the gap would require adding a `[lib]`
target, which is a visible, reviewable change rather than a silent one. The red proof
that was planned — a deliberately failing `///` example — is therefore also not
achievable, and the plan's premise that it was needed is wrong.

### 11. Mutation testing — **measured, NOT gated**, and the measurement is incomplete

**There is no mutation gate in this repository, and that is a decision rather than an
omission.** The advisor ranked `measure_first_no_gate` at 0.99 with confidence 0.99: a
nightly gate that is mostly red is doctrine rule 2, a training failure, and mutants on a
TUI binary are exactly the case where most of them would survive.

**What was actually measured, and what was not.**

```sh
cargo mutants --workspace --list | grep -cE '^packages/.*: (replace|delete|insert|change|swap)'
# 429
```

429 mutants the crate generates, distributed:

| File | Mutants |
|---|---|
| `main.rs` | 161 |
| `session.rs` | 94 |
| `dossier.rs` | 65 |
| `prompt.rs` | 43 |
| `boundary.rs` | 34 |
| `workspace.rs` | 32 |

`boundary_drift.rs` generates none.

**The killed / timeout / survived split was NOT obtained, and no number is recorded here
because none was measured.** The run fails on this host:

```
Caused by: Disk quota exceeded (os error 122)
ERROR Worker thread failed: failed to overwrite
  "/tmp/cargo-mutants-…/packages/rust-tui/src/main.rs"
```

`cargo-mutants` copies the working tree per worker, and this repository carries a 463M
`node_modules` and a 1.8G `target`. `/tmp` is a **32G tmpfs already 79% full**, leaving
about 6.6G. Eight workers need up to ~14G of copies; two workers still exhausted the
quota. `--gitignore true` is set — `node_modules/` and `target/` are both ignored at
`.gitignore:18` and `.gitignore:19` — and the run still fails, because the copy plus
each worker's own build has to fit.

A partial run did reach 35 mutants before the quota, of which **40 were flagged unviable
cumulatively** (33 by the 35th). That is a real observation and it is the wrong one to
generalise from — unviable is a pre-check, not a test outcome, and a 40-of-429-ish
unviable rate says nothing about how many of the rest are killed.

**So the question this measurement was supposed to answer is still open:** whether enough
of these 429 mutants are killed to make a nightly gate honest. Answering it needs a host
with more free space than this one has, or a scoped run (for example `cargo mutants -p
terminal221b-tui --test workspace` for one file) that fits the quota. Until that number
exists, no mutation gate is wired, and the cost of the instrumentation in CI is not
being paid for a result nobody has seen.

This section exists so the next session does not re-litigate the decision. The decision
to measure first is settled; the measurement is not finished.

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
| `gitleaks/gitleaks-action` | v3 | `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` |

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
