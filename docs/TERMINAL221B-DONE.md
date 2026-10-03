# Terminal221b — Definition of Done

This file exists because the programme did not have one, and that absence was the
reason each pass discovered more work. A plan with no finish line is not a plan; it
is a queue that refills.

**Re-derive every number here with the command printed beside it.** That rule is not
decorative — it is the reason the commands are in the table.

---

## 1. What "done" means

The programme is finished when **all three** of these are true. Not two of three.

| # | Criterion | How to check | Current |
|---|---|---|---|
| D1 | Every gate in the register is **green and blocking** | see the yaml check below → `continue-on-error present: False` | **MET** |
| D2 | No gate in the register is **red, or red-but-non-blocking** | `npm run typecheck:tests` → `exit 0` | **MET** |
| D3 | Every gate in the register has a **recorded red proof** | each `### N` section of the register shows the defect and the exit code | **MET for every gate that can be made to fail on demand** — §3 |

**D1 and D2 are one decision, not two.** The only reason D1 fails today is the single
`continue-on-error: true` in `.github/workflows/ci.yml`. Until the `AttestedRecord`
fork is decided, the programme is not finished and cannot honestly claim to be.

---

## 2. D1 and D2 — closed 2026-10-03

This section used to say the programme could not finish. It can.

`npm run typecheck:tests` was the only job in `.github/workflows/ci.yml` carrying
`continue-on-error: true`, and it was the only reason D1 and D2 failed. Its six errors
came from `packages/cli/tsconfig.test.json`, which reaches the 18 CLI test files that
`packages/cli/tsconfig.json` cannot, because that one's `include` is `["src/**/*.ts"]`.

The fork was escalated and is now **decided: the `AttestedRecord` narrowing is
deliberate.** `packages/cli/src/store.ts:125` defines it as `{ version: 1;
attestation?: Attestation }`, and `recordsOfKind` at `store.ts:154` casts because the
five per-kind types cannot be expressed generically. The comment above
`attestationPayload` at `store.ts:432` gives the reason the erasure is load-bearing on
the provenance path.

So the tests were wrong, and **no production type was weakened** — `be2934f` touches
nothing under `packages/cli/src/`. The gate went blocking in `ad482df` and exits 0.

One of the six was not a fork at all but a bug, and a worse one. `ranking.test.ts`
imported `parseBountyScope` from `../src/case.js`, which does not re-export it, so it
was `undefined` — and the only test using it asserted that calling it throws, which
`TypeError: not a function` satisfies. That test had been green while proving nothing.
Fixed in `5a5a88f`.

---

## 3. Where D3 actually stands

There are nine gate sections in the register. **Six have recorded red proofs:**
clippy (§1), fmt (§2), the executed-count floor (§3), the sandbox probe (§3b), the
component floor (§3c), and gitleaks (§4).

**Three do not, and the register says so itself** — §6 `cargo deny` is marked "Not yet
proven red" and §7 CodeQL "Not executable locally". Both have since run green in CI,
but running green is not the same as having been seen to fail.

**And these CI steps were not in the register at all**, so they had neither a red
proof nor a written standard: `lint`, `typecheck`, `build:cli`, `build`, `test`
(`quality` job) and `cargo test`, `cargo build` (`rust` job).

**All seven are now red-proved and recorded in `docs/TERMINAL221B-GATES.md` §8**,
each against a real defect and each reverted afterwards with `git status` confirmed
empty. Two of the seven produced a *false* negative first and are recorded there
because nearly became false conclusions — one because `eslint.config.mjs` sets
`varsIgnorePattern: '^_'` and my probe variable was named `__lint_probe`, and one
because `expo install --check` reads the installed tree (§3a).

**What remains for D3:** §6 `cargo deny check all` and §7 CodeQL have run green in
CI but have never been seen to fail, and CodeQL cannot be made to fail on demand
from this machine at all. Those two are the remainder, and neither is closable by
planting a defect.

Re-derive the audit:

```sh
grep -cE '^### [0-9]' docs/TERMINAL221B-GATES.md        # 9 gate sections
grep -n 'Proven red\|Red proofs' docs/TERMINAL221B-GATES.md
npm run typecheck:tests; echo "exit $?"                  # exit 0
```

`continue-on-error` cannot be counted with `grep`, because the ci.yml comment
explaining why it was removed contains the string. Ask the YAML instead:

```sh
python3 -c "import yaml; print('continue-on-error present:', 'continue-on-error' in yaml.safe_load(open('.github/workflows/ci.yml'))['jobs']['typecheck-tests'])"
# continue-on-error present: False
```

### 3a. Corrections to the record

Two commands have been reported in this project's notes as passing checks. Neither is
a gate, and calling them one was wrong:

- `npx expo install --check` — **not in CI.** It also reads the *installed* tree, not
  `package.json`: drifting `expo` from `~57.0.26` to `~56.0.23` in `package.json`
  still reports "Dependencies are up to date", because the check inspects
  `node_modules`. Its red proof is therefore not cheap, and it has none.
- `npx expo-doctor` — **not in CI.** Reports 21/21 locally. No red proof.

Neither is promoted to a gate here. Promoting a check that has never been seen to
fail is the exact failure this programme exists to prevent, and it would be a
regression dressed as progress. If SDK version drift should be gated, that is its own
commit with its own red proof, and it needs a way to fail that editing
`package.json` cannot bypass.

---

## 4. Parked — operator decisions, not agent work

These cannot be advanced by an agent. They are parked with a trigger so they stop
being re-raised each pass.

| Decision | Blocks | Trigger to revisit |
|---|---|---|
| **Who owns the `@terminal221b` npm scope**, and is that name still free? | the npm publish | decided *that* it publishes; the scope must be created before the first publish can be attempted, and npm gives no public read on whether a name is taken — the 403 from `npmjs.com/org/terminal221b` is returned for orgs that do not exist too |
| crates.io account + 2FA, and the API token for `cargo login` | the crates.io publish | same: the name `terminal221b-tui` was free when checked, and nothing has been published |
| Does the mobile app ship to stores, or stay internal? | most of Phase 6 | the first store submission |
| `allowUnsandboxed` when bwrap is present but **broken** | `packages/cli/src/executor.ts` | if a caller ever needs the opt-in |
| The `AttestedRecord` narrowing (§2) | D1, D2 | next planning round |

**Resolved 2026-10-03: "Does the CLI ship?" is answered yes** — the operator chose to publish to
npm and to crates.io, accepting that a first publish claims each name permanently. The two gates
that make both publishes *possible* are in place (§7). The publishes themselves have not been
performed: they need an account, 2FA and a token, and each one is a one-way door that should be
authorised on its own rather than inherited from a plan.

**No agent may assume an answer to any of these and proceed.** Assuming one produces
work that has to be thrown away, which is how the programme got into a loop.

---

## 5. Not started, and deliberately so

| Phase | Status | Why not now |
|---|---|---|
| 3 — coverage and mutation | **done** | coverage gated (TS 75, Rust 65); mutation measured-not-gated, and the killed/timeout/survived split is still unmeasured on this host |
| 4 — CLI distribution | **gates in place; the two publishes are not done** | §7 |
| 5 — agent harness | not started | agents inherit whatever enforcement exists |
| 6 — E2E and release | partly parked | the mobile-store decision (§4) |

Adding capability before meeting D1–D3 is how the finish line kept moving. The work
that closes this programme is the work that removes gates, not the work that adds
them.

---

## 6. The honest summary

Re-derive the current state:

```sh
npm ci && npm run build:cli
npm test && npm run test:count          # 390 executed, floor 390/384
npm run test:components && npm run test:count:components   # 4 executed, floor 4
cargo test --workspace --locked         # 60 passed
```

The gates are real, the counts hold, and the red proofs for the load-bearing gates
are recorded. What is missing is narrow and specific: one operator decision (§2), and
the red proofs listed in §3. Neither is large. Both are finishable.

---

## 7. Phase 4 — the two distribution gates

Two gates added, both answering a question no earlier gate could.

| Gate | Question it answers | Red-proof status |
|---|---|---|
| §12 `scripts/assert-tarball-contents.sh` + `publint` | does the **published tarball** contain what it should, and nothing it should not? | 4 red proofs recorded |
| §13 `scripts/assert-crate-publishable.sh` | would `cargo publish` **succeed**, without publishing? | went red on its first honest run, on a real bug; **green since the fix** |
| §14 `scripts/assert-boundary-copies-identical.sh` | are the CLI and the TUI enforcing the **same** boundary policy? | 2 red proofs recorded |

Re-derive:

```sh
./scripts/assert-tarball-contents.sh       # 25 files, all accounted for
npx --yes publint@0.3.25 packages/cli      # All good!
./scripts/assert-crate-publishable.sh      # publishable — packaging, metadata, verify build
./scripts/assert-boundary-copies-identical.sh   # the CLI and the TUI agree
```

### 7a. `terminal221b-tui` was unpublishable — found, fixed, and now gated

This section previously reported a blocker and left it standing. It is fixed.

`boundary.rs` embedded the provider boundary with `include_str!("../../cli/resources/
provider-boundary.json")` — a path leaving the crate directory. It resolves in this repository
and cannot resolve in a packed crate, so the crate **has never been publishable**. It survived
because every Rust gate builds the working tree; only `cargo publish --dry-run` builds the
packaged artefact, and that is the gate that found it.

The fix keeps the canonical file in `packages/cli/` (the npm package reads it at runtime) and
gives the crate its own copy, which is what `include_str!` requires. That created a new failure
mode — the policy now exists twice — so the copy is enforced three ways, and
`scripts/assert-boundary-copies-identical.sh` is the one that names the file that drifted.
Without it the fix would have traded a loud failure for a quiet one on a security policy.

```sh
ls -d /tmp/t221b-* /tmp/terminal221b-* 2>/dev/null | wc -l   # 0
```

**Neither package has been published.** `terminal221b-tui` 0.1.0 **is** published — verified by a
clean `cargo install` into an isolated `CARGO_HOME`, which compiled and ran, and by confirming
`resources/provider-boundary.json` is inside the downloaded `.crate`. `@terminal221b/cli` is not:
`npm whoami` is unauthenticated, and the `@terminal221b` scope must be created first. Its first
publish is permanent — npm's version can be deprecated but never withdrawn, and cargo's "can never
be overwritten, and the code cannot be deleted" — so each remains a separate authorisation rather
than something this phase performs on the strength of a plan.

**Three findings from this phase that are worth more than the two gates:**

1. `prepare` was the load-bearing change, not the gate. Without it a clean-checkout pack emits
   **4 files and no `dist/`** — a `bin` that installs and then does nothing. Measured.
2. `attw` and `cargo-semver-checks` are both **inapplicable**, not merely absent — one has no type
   surface to resolve, the other has no API to check. Neither is wired. Two tools removed from the
   plan on evidence is a success, not a shortfall.
3. The tarball gate was itself wrong **1 run in 20** — a `printf | grep -q` SIGPIPE race under
   `set -o pipefail` that reported a present file as missing. It misattributed itself to `npm pack`
   and then to a stale temp directory before the real cause was found. Re-verified **0 red in 60
   runs.** A gate that names the wrong cause is worse than no gate, because it sends you to fix
   the wrong thing.
4. The crate gate found a **pre-existing publishing blocker** on its first honest run (§7a). The
   crate had never been publishable, and no gate in this repository could have found it, because
   every one of them builds the working tree rather than the packaged artefact. Fixed in `c5e94e0`
   and gated in `8f309e9`.
5. The same `| head`-under-`pipefail` defect appeared **twice**, in two scripts written hours
   apart, each producing a red whose exit code misdescribed its own cause (141/SIGPIPE instead of
   1). Both were caught by their red proofs, not by reading the code. `| head` and `| tail` in a
   `set -o pipefail` script are a defect, and that is now written down in register §§12 and §14.
