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
| provider boundary copies identical (§14) | `quality` | yes |
| `npm run typecheck` | `quality` | yes |
| `npm run build:cli` | `quality` | yes |
| tarball manifest + `publint` (§12) | `quality` | yes |
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
| `cargo publish --dry-run` (§13) | `rust` | yes |
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

### 12. The tarball manifest — `scripts/assert-tarball-contents.sh` + `publint`

```sh
./scripts/assert-tarball-contents.sh
./scripts/assert-boundary-copies-identical.sh
npx --yes publint@0.3.25 packages/cli
```

**Why this gate exists at all.** Until this phase, `packages/cli` was `"private": true` and had
never been packed, so nothing needed checking. Publishing it makes "it packs" a claim, and
`npm pack` exiting 0 is a claim about npm, not about this package. It is satisfied by a tarball
whose `bin` points at a `dist/` that does not exist, with no licence, carrying a test fixture.

**The single highest-value change in the phase is not this gate** — it is the `prepare` script in
`packages/cli/package.json`. Measured, not assumed:

```sh
# a copy of the package with `prepare` removed and no dist/
npm pack --dry-run        # ->  total files: 4,  no dist/cli.js
```

Four files, no `dist/`, and a `bin` that would install successfully and then do nothing. npm runs
`prepare` **before** packing, so `prepare: "npm run build"` makes a clean checkout packable. With
it, the same clean-checkout pack produces **23** files including `dist/cli.js`; with `LICENSE` and
`README.md` added (§ below) the gate measures **25**.

**The gate asserts an exact set, not a subset.** A check that only asserts "the files I remember
are present" passes when a new file is added, and the way a package ships a secret is by a file
nobody listed. The expected set is *derived*, not hard-coded: `dist/*.js` from `src/*.ts` by name,
plus every file in `resources/`, plus four required files. Deleting a source file needs no edit to
the script, and the assertion still catches a `dist/` stale relative to `src/`.

It additionally forbids `src/`, `tests/`, `tsconfig*`, `node_modules/`, `coverage/`, `target/` and
`*.tgz`; denies credential-shaped *filenames* (`.env*`, `*.pem`, `*.key`, `id_rsa*`,
`credentials*`, `*.keystore`); requires `dist/cli.js` to be non-empty and to start with a shebang;
and pins the set of `.sh` files to the single one `npm run lint:shell` covers.

Credential matching is on **names, not contents**, and that is deliberate: `resources/
provider-boundary.json` contains the words "secret", "API keys" and "credentials" in its policy
prose. A content scan would flag the very rules that forbid handling a secret.

**Red proofs.** Four, each observed:

| Probe | Result |
|---|---|
| `packages/cli/LICENSE` removed | `::error::LICENSE is missing from the tarball.` |
| `packages/cli/resources/probe.sh` added | `::error::unreviewed shell scripts in the tarball: resources/probe.sh` |
| `packages/cli/resources/prod.pem` added | `::error::the tarball contains credential-shaped filenames: resources/prod.pem` |
| `bin` pointed at `./dist/does-not-exist.js` | `publint` → `pkg.bin.terminal221b is ./dist/does-not-exist.js but the file does not exist.` |

`publint` also found one real defect on first run, now fixed: `pkg.repository.url` was a plain
`https://` URL where a `git+https://` form is expected.

#### A red proof that did not work, and what it taught

The first red proof attempted here was adding `packages/cli/tests/probe.json` — a test fixture
carrying a fake key, the realistic leak. **It passed green.** Not because the gate is correct, but
because `files: ["dist", "resources"]` already excludes `tests/`, so the file could never reach the
tarball.

That is worth recording rather than quietly replacing with a probe that works. The `files`
allowlist is a real filter, and every forbidden-pattern check in this gate is shielded by it. A
shielded check is not a verified one. The probes that follow were re-run through
`resources/`, which *is* inside the allowlist and therefore genuinely reaches the tarball — and
those are the ones that went red.

#### This gate was wrong 1 run in 20, and the bug was a race

An early version of this script asserted file presence with:

```sh
printf '%s\n' "${ACTUAL[@]}" | grep -qxF "$f" || fail "..."
```

Under `set -o pipefail` that is a race. `grep -q` exits the moment it matches, `printf` takes
SIGPIPE, and `pipefail` reports the pipeline's failure — so a file that **is** present reads as
missing. It reported a missing `README.md` on 1 run in 20 while `README.md` was present in every
tarball, and it was misattributed twice before the cause was found: first to `npm pack`
(measured 0/30 failures across 30 raw packs — npm is deterministic), then to a stale temp
directory. **The flake was in the gate, not in npm.**

The fix is to grep the manifest *file* rather than pipe an array through `printf`, so there is no
pipe to lose the race, and to use one `LC_ALL=C sort` for both `comm` inputs. Re-verified over **60
consecutive runs: 0 red.**

The general lesson, and the reason it is written down: a gate that reports a *wrong* reason is
worse than no gate, because it sends you to fix the thing it names. The misattribution cost more
time than the defect it was hiding.

#### `attw` is deliberately NOT in this gate

`@arethetypeswrong/cli` 0.18.5 was run against the real tarball:

```
$ npx --yes @arethetypeswrong/cli@0.18.5 terminal221b-cli-0.1.0.tgz
This package does not contain types.
{ "packageName": "terminal221b-cli", "packageVersion": "0.1.0", "types": false }
exit 0
```

It resolves a package's `exports` map and TypeScript declaration surface. This package is a
bin-only, `type: module` CLI with no `exports`, no `main` and no `types` — there is nothing for it
to resolve. **It cannot go red on this package**, and a gate that cannot fail is worse than no
gate, so it is not wired. The plan predicted this and specified removal rather than leaving it in
to make the step look thorough. It is recorded here so the next session does not re-add it.

`attw` is the second tool in this repository that is inapplicable rather than merely absent; see
§13 for the first.

### 13. `cargo publish --dry-run` — `scripts/assert-crate-publishable.sh`

```sh
./scripts/assert-crate-publishable.sh
```

**The question no other gate answers.** `cargo build --workspace --locked` builds the crate against
the working tree and the workspace around it. `cargo publish --dry-run` packages the crate and
builds the **packed** result, which is the thing that has to compile on crates.io. A crate that
builds here because it can see its neighbours, and fails there because the tarball is missing
something, is invisible to every gate already in this register.

It runs in two passes on purpose. Pass 1 is `--no-verify`: fast, and its errors are about the
manifest. Pass 2 builds the packed crate. Separated so a typo in a `readme` path and a compile
error do not print the same message — the difference between a red build you can act on and one
you re-run by hand to understand. `--locked` throughout, so the gate cannot pass against a
lockfile that differs from the committed one.

**A property of this gate worth knowing before running it locally:** `cargo publish` refuses to
package a **dirty** working tree.

```
error: 2 files in the working directory contain changes that were not yet committed into git:
packages/rust-tui/Cargo.toml
packages/rust-tui/README.md
to proceed despite this and include the uncommitted changes, pass the `--allow-dirty` flag
```

So this gate is meaningful on a clean tree — in CI, always, and locally, only after committing.
`--allow-dirty` is deliberately **not** used: it would let a local run pass against state that CI
would reject, which is precisely the kind of green that does not mean anything.

**Red proofs.** Two observed, both from the manifest half:

| Probe | Result |
|---|---|
| `readme = "README-does-not-exist.md"` | `::error::Cargo.toml names readme = "README-does-not-exist.md", which does not exist.` |
| `description` line deleted | `::error::Cargo.toml is missing the required field: description` |

Both are the checks crates.io only *warns* about. That is the point of asserting them here: a
warning nobody reads is not a gate, and `readme` pointing at a missing file would otherwise ship
as a published crate carrying no description of itself.

#### The verification half went red on a real bug, and that is the whole point

The third red proof was attempted for real: exclude `src/main.rs` from `include/` and prove the
verification build catches a crate that cannot build once packed. It never got that far, because
the gate was **already red** before any probe was planted.

```sh
$ cargo publish -p terminal221b-tui --dry-run --locked
   Verifying terminal221b-tui v0.1.0
   Compiling terminal221b-tui v0.1.0 (…/target/package/terminal221b-tui-0.1.0)
error: couldn't read `src/../../cli/resources/provider-boundary.json`: No such file or directory
   --> src/boundary.rs:154:5
    |
154 |     include_str!("../../cli/resources/provider-boundary.json")
```

**`terminal221b-tui` has never been publishable.** `boundary.rs:154` embeds the provider boundary
with `include_str!("../../cli/resources/provider-boundary.json")` — a path that leaves the crate
directory. It resolves in this repository, where `packages/cli/` sits next to `packages/rust-tui/`,
and it does not exist inside a packed crate, where only the crate's own files travel. Every
existing Rust gate passes, because every existing Rust gate builds the **working tree**; this is
the first thing in the repository to build the **packaged** crate.

Confirmed pre-existing, not introduced by the `include/` added for crates.io: the same failure
reproduces against `22e9f75`, before this phase touched `Cargo.toml`.

This is a gate doing exactly its job on its first honest run. The alternative — a repository that
believes its crate is publishable until someone tries to publish it — is the state this gate was
written to end. The fix is not mechanical and is **not** taken here; it changes where the single
source of truth for the boundary policy lives, and that file is a security policy. See
`docs/TERMINAL221B-DONE.md` §7.

### 14. Provider boundary copies are identical — `scripts/assert-boundary-copies-identical.sh`

```sh
./scripts/assert-boundary-copies-identical.sh
```

**Why a gate about two files that used to be one.** The provider boundary is a security
policy — no secrets, no wallet custody, no command execution — rendered by two surfaces. It
is now committed twice:

| Path | Read by |
|---|---|
| `packages/cli/resources/provider-boundary.json` | the npm package, at **runtime** |
| `packages/rust-tui/resources/provider-boundary.json` | the crate, at **compile time** via `include_str!` |

The second copy is not a preference. `include_str!` cannot read outside the crate directory in
a *published* crate, so without an in-crate copy `terminal221b-tui` does not compile at all
(§13). Two files means a policy edit can land in one and not the other, and the failure is
silent: the TUI enforces a weaker boundary than the CLI, and nothing notices.

**The existing drift guards do not catch this, and that is worth being explicit about.**
`boundary_drift.rs` and `boundary-drift.test.ts` each read **one** file and prove that a
renderer notices a mutation. That was sufficient while there was one file. With two, every test
in both files can be green while the copies disagree. The drift arrived by a different route
than the drift those files were written for.

**Three checks of one invariant**, deliberately rather than redundantly:

| Check | Runs in | Why it is not enough alone |
|---|---|---|
| `scripts/assert-boundary-copies-identical.sh` | its own CI step | needs a checkout; nothing else |
| `boundary_drift.rs` → `the_embedded_copy_is_byte_identical_to_the_canonical_file` | `cargo test` | only for people who run the Rust suite |
| `boundary-drift.test.ts` → "the crate's copy is byte-identical to this one" | `npm test` | only for people who run the TS suite |

A check that cannot run in some environment should not be the only thing standing between a
policy edit and a weaker security boundary. The script is the one that works everywhere and
names the offending file; the tests are the ones that run for anyone who only runs the suites.

**Red proofs, all observed:**

| Probe | Result |
|---|---|
| a prohibition removed from the crate's copy | the script names the clause and the line; the Rust test fails; the TS test fails; **the Rust control test fails too** |
| the crate's copy deleted | `::error::packages/rust-tui/resources/provider-boundary.json is missing.` plus why the crate needs one |

The failure names the differing line, because on a security policy "the files differ" is not
actionable and "`no_wallet_secrets` is in one and not the other" is.

**A bug this gate found in itself, the same class as §12.** The first version diffed through a
pipe into `head`:

```sh
diff -u "$CANONICAL" "$MIRROR" 2>&1 | head -20 | sed 's/^/::error::  /'
```

Under `set -o pipefail`, `head` closing the pipe early gives `diff` SIGPIPE and the script exits
**141** — still red, but for a reason that has nothing to do with drift, and it printed
`diff: missing operand` on top. Caught by the red proof, not by reading the code. It now writes
the diff to a file and reads it back, and the same probe exits a clean **1**.

That is twice, in two different scripts written hours apart, that a piped `head` under
`pipefail` produced a failure whose exit code misdescribed its own cause. The pattern is worth
remembering: **`| head` and `| tail` in a `set -o pipefail` script are a defect**, because they
turn a normal exit into a signal.

**Design decided with `jev`**, confidence reported because a number without its source is not a
number:

| Decision | Answer | Confidence |
|---|---|---|
| where the canonical file lives | `cli_owns_crate_copies` | **0.96** |
| how equality is enforced | `script_gate` | **0.62** |
| intended edit workflow | `edit_canonical_then_sync` | **0.91** |

The 0.62 is the weakest of the three and is the one worth re-asking: `diff_in_both_langs` was
the runner-up at 0.25. It was not chosen because the TS and Rust suites are split across two CI
jobs and neither job can see the other language's file as a test input it trusts, so a
test-only gate would silently protect one surface depending on which suite a contributor
happens to run. All three checks are wired anyway.

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

## 15. The published name, and why it is unscoped

Not a gate. Recorded because the reasoning is not obvious from the name, and because
the next person to see `terminal221b-cli` may assume an org was created that was not.

**The problem this solves.** The package was going to publish as `@terminal221b/cli`.
npm gives **no public read on whether a scope name is claimable**:

```sh
$ curl -o /dev/null -w "%{http_code}" https://www.npmjs.com/org/terminal221b
403
$ curl -o /dev/null -w "%{http_code}" https://www.npmjs.com/org/zzz-definitely-not-an-org-9x7q
403     # an org that certainly does not exist, same answer
```

403 either way, so the only way to learn whether `@terminal221b` was available was to
attempt to create the npm organization — an account action, and a failed one leaves a
half-created org.

**Unscoped names are checkable.** The registry answers definitively, and the probe was
control-tested in both directions before being trusted:

```sh
$ for n in express react typescript lodash; do
    curl -s -o /dev/null -w "$n %{http_code}\n" "https://registry.npmjs.org/$n"; done
express 200   react 200   typescript 200   lodash 200   # taken -> 200
$ curl -s -o /dev/null -w "%{http_code}\n" \
    https://registry.npmjs.org/this-package-really-does-not-exist-9x7q2k
404                                                                              # free -> 404
```

`terminal221b-cli` returned 404. So did `terminal221b`, `t221b`, `terminal-221b` and
`t221b-cli`. The one chosen is the one that reads as "the Terminal221b CLI" without
colliding with the project name itself.

**What was given up, stated plainly.** A scoped package is protected by the org that owns
it; an unscoped name can be squatted after the first publish, and the rename means the
project holds two global names rather than one. Jev was asked to weigh this and chose
unscoped-now at **0.85** (unscoped 0.90 / keep-scope 0.10). The operator accepted it. For a
one-maintainer AGPL project where the risk is a future squatter rather than a security
boundary, that is a reasonable trade — but it is a trade, not a free win.

**The rename is not one line.** Four places couple to the package name, and each fails
differently if missed:

| Place | Failure if missed |
|---|---|
| `packages/cli/package.json` `name` | publishes under the old name |
| root `package.json` ×3 scripts (`build:cli`, `typecheck`, `cli`) | `--workspace @terminal221b/cli` no longer resolves; `npm run build:cli` breaks |
| `package-lock.json` | `npm ci` in CI installs inconsistent state |
| `packages/cli/README.md` | tells users to install a name that does not exist |

The lockfile was regenerated with `npm install --package-lock-only` rather than hand-edited,
and the result checked for both directions of drift:

```sh
grep -c "@terminal221b/cli" package-lock.json   # 0
grep -c "terminal221b-cli"    package-lock.json   # 2
npm ci && npm ls --workspaces --depth 0          # clean, no "extraneous"
```

`npm ls` reported the renamed workspace as `extraneous` until the lockfile was regenerated.
That is the symptom of a half-rename, and it is why the lockfile is regenerated rather than
sed-ed.

Verified after the rename, all on the same tree: `npm ci` exit 0 · `npm run build:cli` exit 0 ·
`npm publish --dry-run` → `Publishing to https://registry.npmjs.org/ with tag latest and public
access` · tarball gate 25 files · `publint` All good · `npm test` 391 · components 4 ·
`cargo test` 61 · zero temp-dir leaks.

## 16. Environmental, not a gate: `rm` does not remove anything on this host

renumbered from 15 to 16 when section 15 (the published name) was added above it.

Not a gate, and deliberately not made into one. Recorded because it cost real time
and it presents as a code regression.

`rm` is a shim at `~/.minimax/shims/rm` that forwards its argument to a trash helper
**without shell-expanding it**:

```sh
$ T=$(mktemp -d); rm -rf "$T"
mavis-trash: '/tmp/$T': No such file or directory
mavis-trash: no files were moved
$ [ -d "$T" ] && echo LEAKED
LEAKED
```

Every `rm -rf "$VAR"` in this repository was therefore a no-op that reported success.
The scripts in `scripts/` now resolve `command rm` explicitly (`rm_impl`), which is
correct on this host and on a normal one.

**What it cost.** The repository had accumulated **25,152** leaked `t221b-*`
directories under `/tmp`, totalling **880M**. The 32G tmpfs filled, and the next
`cargo test --workspace --locked` failed **8 tests**:

```
thread 'session::tests::transcript_round_trips_and_overwrites_atomically' panicked
  at packages/rust-tui/src/session.rs:440:
called `Result::unwrap()` on an `Err` value: Os { code: 122,
  kind: QuotaExceeded, message: "Disk quota exceeded" }
```

Eight failing tests, in `session.rs` and `workspace.rs` — files no recent change had
touched. Re-run after clearing `/tmp`: **61 passed, 0 failed.** Nothing in that
output points at disk space, which is what makes it worth writing down: the natural
reading is a regression in the boundary fix, and chasing that would have meant
reverting correct work.

**Also still leaking — and the first diagnosis of it was wrong.** An earlier version of this
section attributed the remaining leak to the same `rm` shim, on the grounds that the CLI test
suites call `rm -rf` on their temp directories. They do not: they call `rm`/`rmSync` from
`node:fs`, which is a syscall and does not go through a shell at all. Measured:

```sh
$ T=$(mktemp -d); node -e 'require("fs").rmSync(process.argv[1],{recursive:true})' "$T"
$ [ -d "$T" ] && echo LEAKED || echo removed-cleanly
removed-cleanly
```

The shim was a real defect and is fixed, but it was **not** the cause of the test-suite leak.
That one was simpler: three test files created temp directories and never removed them.

| File | `mkdtempSync` per run | Cleanup before |
|---|---|---|
| `packages/cli/tests/store.test.ts` | 78 | **none** |
| `packages/cli/tests/executor.test.ts` | 7 | **none** |
| `packages/cli/tests/case.test.ts` | 1 | **none** |

`store.test.ts` carried a comment claiming its directories were "deleted by the caller's temp
dir lifetime". They were not, and nothing in the file deleted them. A comment asserting a cleanup
that does not exist is worse than no comment.

All three now track their scratch roots and remove them in `afterAll`. They are tracked rather
than removed inline because the tests assert on paths *inside* them, so each must outlive the
`it` that created it and die after the suite.

Measured after the fix:

```sh
npm test                                                   # 391 passed
ls -d /tmp/t221b-* /tmp/terminal221b-* 2>/dev/null | wc -l  # 0
```

**0 before, 0 after.** For the record, the sequence that found it: 25,152 directories and 880M
(cargo test failing 8 Rust tests) → 153 after fixing the shim alone → 5 after three files → 0.
The shim fix was worth making on its own merits and fixed none of the test-suite leak, which is
why it is recorded separately from the finding it was originally blamed for.

```sh
ls -d /tmp/t221b-* /tmp/terminal221b-* 2>/dev/null | wc -l   # 0
du -csh /tmp/t221b-* 2>/dev/null | tail -1                  # nothing
df -h /tmp | tail -1
```

## Gates deliberately NOT installed yet

Recorded so their absence reads as a decision rather than an oversight.

- **`cargo-semver-checks`** — **inapplicable, not deferred.** `terminal221b-tui` is a bin-only
  crate: it has a `[[bin]]` and **no `[lib]` target**, so it exposes no public Rust API and
  therefore has no semver surface to check. There is no release pipeline to attach it to either,
  but that is the smaller reason — attaching it to a crate with no API would produce a green
  forever and the appearance of a checked contract. Corrected 2026-10-03; this line previously
  said "release CI only", which implied it would apply once a pipeline existed.
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
./scripts/assert-crate-publishable.sh    # needs a clean tree; see section 13

./scripts/assert-tarball-contents.sh
./scripts/assert-boundary-copies-identical.sh
npx --yes publint@0.3.25 packages/cli

gitleaks detect --no-git --source . --redact
# cargo deny check all        # requires: cargo install cargo-deny --locked
```

`npm run typecheck:tests` is expected to **exit 2** until the `AttestedRecord` fork in
§5 is decided. That is the documented state, not a regression.
