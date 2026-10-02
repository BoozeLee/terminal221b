# Terminal221b engineering guide

**Status: Shipped and Planned, per section.** This guide is a synthesis. It does
not replace the documents it cites; where two could disagree, the cited
document wins and this one is the error. Code is authoritative over both.

- **Shipped** — measured in this repository, with the command that proves it.
- **Planned** — designed but not implemented. No claim in a Planned section may
  be reported as a feature.

Nothing here is new product design except the three sections marked
**[new]**: §3 (dependency ledger), §7.4 (designer workflow spec), and §8.5
(planned read-only smart-contract integration). Everything else is a pointer
plus the constraint that a reader would otherwise have to go find.

## 0. Document map

| Area you asked about | Answered in | Authority for the detail | State |
| --- | --- | --- | --- |
| Dependencies | §1, §3 | [package.json](../package.json), [packages/cli/package.json](../packages/cli/package.json), [Cargo.toml](../packages/rust-tui/Cargo.toml), [toolchains/tooling.json](../toolchains/tooling.json) | Shipped |
| Technical setup and installation guide | §1, §2, §8 | [README.md](../README.md) §Quickstart, [CONTRIBUTING.md](../CONTRIBUTING.md) | Shipped |
| AI development | §4 | [prompt.ts](../packages/cli/src/prompt.ts), [anthropic.ts](../packages/cli/src/anthropic.ts), [SECURITY.md](../SECURITY.md) | Shipped, with one boundary not yet built |
| TUI building | §5 | [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) | Shipped |
| Engineering architecture | §6 | [TERMINAL221B-SYSTEM-ARCHITECTURE.md](TERMINAL221B-SYSTEM-ARCHITECTURE.md) | Shipped |
| Designer GUI and TUI | §7 | [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) §Decision, blueprint §5 | Shipped surfaces, planned GUI |
| Smart contract tools | §8 | [toolchains/tooling.json](../toolchains/tooling.json), blueprint §9 | Shipped install + local scanning, planned integration |
| Integration plan | §9, §10 | [blueprint §11](TERMINAL221B-SYSTEM-ARCHITECTURE.md#11-phased-implementation-sequence) phase table, [§13](TERMINAL221B-SYSTEM-ARCHITECTURE.md#13-open-decisions-before-implementation) open decisions | Shipped phases 0–1, planned 2–6 |
| Prompt framework | §4.4 | [TERMINAL221B-AGENTIC-ENGINEERING.md](TERMINAL221B-AGENTIC-ENGINEERING.md) | Shipped |

Documents this guide defers to, in the order to reach for them:

1. [README.md](../README.md) — what the operator can actually do today.
2. [TERMINAL221B-AGENTIC-ENGINEERING.md](TERMINAL221B-AGENTIC-ENGINEERING.md) — mission,
   operating principles, work modes, prompt framework, boundaries. **Read this
   before proposing any change.**
3. [TERMINAL221B-SYSTEM-ARCHITECTURE.md](TERMINAL221B-SYSTEM-ARCHITECTURE.md) — the design,
   the phase table, the risks, the open decisions.
4. [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) — why the TUI is Rust, and what that
   decision forbids.
5. [TERMINAL221B-CASE-STORE.md](TERMINAL221B-CASE-STORE.md) and
   [TERMINAL221B-CASE-THREAT-MODEL.md](TERMINAL221B-CASE-THREAT-MODEL.md) — what the store
   vouches for, and the twenty findings that bound it.
6. [TERMINAL221B-FRESHNESS-REVIEW.md](TERMINAL221B-FRESHNESS-REVIEW.md) — the freshness
   arithmetic and its one-sided boundary.

## 1. Prerequisites and version floors

| Requirement | Floor | Declared in | Verify | Needed by |
| --- | --- | --- | --- | --- |
| Node.js | 22 | `packages/cli/package.json` `engines.node`; [CONTRIBUTING.md](../CONTRIBUTING.md) | `node --version` | `npm run build:cli`, `npm test`, `npm run typecheck` |
| npm | ships with Node 22 | [CONTRIBUTING.md](../CONTRIBUTING.md) requires `npm ci` | `npm --version` | every npm script |
| Rust toolchain | 1.88, edition 2024 | `packages/rust-tui/Cargo.toml` (`rust-version`, `edition`) | `cargo --version` | `npm run tui`, `npm run build:tui`, `cargo test --workspace` |
| Python + `pipx` | 3.11+ recommended | `toolchains/tooling.json` ("Python isolated environment") | `pipx --version` | bandit, semgrep, slither, solc-select |
| Arch Linux / Omarchy | — | `packages/cli/resources/omarchy-toolchain-plan.sh` refuses non-Arch | `pacman --version` | the AUR and `officialArchPackage` names in §8 |
| `shellcheck` | any current | `npm run lint:shell` | `shellcheck --version` | `npm run lint:shell` only |
| A provider key | — | `.env.example` | see §4.1 | `ask`, `crypto ask`, the TUI, the Expo app |

Two of these are worth stating explicitly because they are easy to get wrong:

- **Edition 2024 is a real floor, not a style choice.** An older stable Rust
  will refuse the package rather than warn.
- **The Expo app does not read secrets from the environment.** `.env.example`
  says so, and it is load-bearing: the key is typed into Settings and stored by
  the platform (`expo-secure-store` on native, memory-only on web).
  `EXPO_PUBLIC_*` is forbidden in every context. `ANTHROPIC_API_KEY` is for the
  terminal CLI and the TUI only.

## 2. Install and verify, failing fastest

Order matters. Each block is verifiable on its own, so a failure names a
surface instead of the whole project.

### 2.1 JavaScript and the CLI

```sh
npm ci
npm run lint
npm test
npm run typecheck
npm run build:cli
```

`npm ci` is the only install that may be relied on; it is what [CONTRIBUTING.md](../CONTRIBUTING.md)
specifies. `npm run build:cli` emits `packages/cli/dist/cli.js`, which is what
every `terminal221b` invocation below actually runs.

### 2.2 The Rust TUI

```sh
cargo build --release -p terminal221b-tui
cargo install --path packages/rust-tui --locked
```

For development, `npm run tui` (which is `cargo run -p terminal221b-tui --`)
skips the install step. The install is what puts `terminal221b-tui` on `PATH`.

> **Verified here on 2026-10-02, with two fixes first.** `AGENTIC-ENGINEERING.md:203-206`
> lists `cargo fmt --all -- --check`, `cargo test --workspace --locked`,
> `cargo clippy --workspace --all-targets --locked -- -D warnings`, and
> `cargo build --workspace --locked` as the CI set. All four now pass on this
> tree. They did not before: `cargo fmt --check` reported three diffs and clippy
> reported a `needless_borrow` at `main.rs:1320`, both in the Slice 5 dossier
> screen, because no CI job had ever run them. Note that CI still does not run
> clippy — see the workflow gap in the roadmap — so the gate is local until that
> changes.

### 2.3 The Expo client

```sh
npm run start      # dev server; press i / a / w
npm run android
npm run ios
npm run web
```

Three things this step cannot prove without a device, a simulator, or a
credential, and which therefore stay unverified: that the app builds for a
target, that a live Anthropic request succeeds, and that the in-app key round-
trips through the platform keystore. `app.json` sets `newArchEnabled: true`, so
a native run exercises the new architecture.

### 2.4 The verification ladder

Narrow changes need the narrow command. A broad release needs the whole set,
plus a documented statement of anything that could not be run.

| Scope | Run |
| --- | --- |
| One pure module in `packages/cli` | `npx vitest run packages/cli/tests/<name>.test.ts` |
| The case path (contracts, gate, store, paths) | `npx vitest run packages/cli/tests/case.test.ts packages/cli/tests/ranking.test.ts packages/cli/tests/store.test.ts packages/cli/tests/path-guard.test.ts` |
| The whole JS surface | `npm run lint && npm test && npm run typecheck && npm run build:cli` |
| Any TUI change | the case above, plus `cargo test --workspace --locked` |
| Any shell resource change | plus `npm run lint:shell` |
| Before a release or a push | all of the above, plus the four cargo commands in §2.2 |

**Measured on this tree on 2026-10-02:** 19 test files, 349 tests, all
passing; `npm run lint`, `npm run typecheck` (root and workspace),
and `npm run build:cli` clean. The four-file case gate is 226 tests. The four
cargo commands of §2.2 are also clean on this tree for the first time —
`cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked
-- -D warnings`, `cargo test --workspace --locked` (56 tests), and
`cargo build --workspace --locked` — so the §2.2 "not verified here" note
above is now obsolete.

The rule, from `AGENTIC-ENGINEERING.md:211`: *do not claim a command passed
unless it was run on the current tree.* This guide treats that as binding on
itself — every "verified" above names the command, and everything else is
marked unverified.

## 3. Dependency ledger **[new]**

### 3.1 What is installed, and why each one is there

Runtime, root (`package.json`):

| Dependency | Version | Why it is here |
| --- | --- | --- |
| `expo` | `~54.0.33` | the app shell; the CLI and TUI do not use it |
| `react-native` | `0.81.5` | Expo's runtime |
| `react` / `react-dom` | `19.1.0` | UI; `react-dom` carries the web target |
| `expo-secure-store` | `~15.0.8` | the only place an API key is stored on native |
| `@react-native-async-storage/async-storage` | `2.2.0` | chat history on device. **Not encrypted** — see [SECURITY.md](../SECURITY.md) |
| `zustand` | `^5.0.11` | the chat store; one store, no state library beyond it |
| `react-native-screens`, `react-native-safe-area-context`, `expo-status-bar`, `react-native-web`, `@expo/metro-runtime` | — | navigation, layout, and the web build |

Development: `typescript ~5.9.2`, `vitest ^5.0.2`, `eslint ^10.11.0` with
`@typescript-eslint/* ^8.71.0`, `@types/react ~19.1.0`.

`@terminal221b/cli` workspace: no runtime dependencies at all. `node:crypto`,
`node:fs`, `node:path` and friends only. The `terminal221b` bin is
`./dist/cli.js`, `type: module`, and `engines.node >= 22`. **A zero-dependency
CLI is a deliberate property, not an accident** — it is what makes the case
path auditable end to end, and it is why `cases` and `store` can be read as
plain TypeScript.

`terminal221b-tui` crate:

| Crate | Version | Why |
| --- | --- | --- |
| `ratatui` | 0.30 | rendering. Ruled in by [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) |
| `crossterm` | 0.29 | terminal events and raw mode |
| `serde` / `serde_json` | 1 | transcript serialization |
| `reqwest` | 0.12 | provider calls — `default-features = false`, features `blocking`, `json`, **`rustls-tls`**, so there is no OpenSSL dependency and the TLS trust path is rustls |
| `tempfile` | 3 | dev-dependency, for session tests |

### 3.2 Deliberate absences

Each of these is a *missing* dependency that a reader might otherwise assume is
an oversight. Each has a reason, and each is a decision to revisit, not a gap
to fill quietly.

| Absent | What it would buy | Why it is absent |
| --- | --- | --- |
| A backend or proxy | key custody, request logging, a shareable sync | it would make the app a server, and `PRODUCT_ROADMAP.md` keeps it a decision, not a plan |
| A local inference runtime (TensorRT, llama.cpp binding) | no provider transmission | not started; roadmap item 7, and it would change the sovereignty claim materially |
| Tauri | a desktop window around the CLI | [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) is explicit that this is a *shell* TUI and a Tauri wrapper is not part of this release; it survives as roadmap item 2 only |
| Textual / any second TUI | a second terminal framework | ruled out: it would duplicate the Rust interface and add a runtime |
| A chain SDK (Solana web3, ethers, viem) | reading a program or contract | §9 of the blueprint draws the lifecycle boundary and §8.5 below keeps it planned |
| A scoring, metrics, or telemetry dependency | aggregate ranking | a weighted number is the failure the ranking design exists to avoid; [README.md](../README.md) Status says so |
| Any secret-management or keyring library | — | the terminal CLI reads `ANTHROPIC_API_KEY` from the environment and nothing else |

### 3.3 Known advisories, and what "resolve" means here

`npm audit --omit=dev` reports **unresolved advisories, including critical and
high**. This is a stated fact in [README.md](../README.md) §Status, not a surprise.

The constraint that shapes the fix: **no untested Expo major upgrade.** A major
Expo bump moves the React Native runtime, the new-architecture flag, the
keystore plugin, and the web bundler at once, and there is no device or
simulator test in this repository to catch the result. So the resolution is
incremental and verified per step, not a version bump. `PRODUCT_ROADMAP.md`
item 5 and [README.md](../README.md) roadmap item 5 both name it.

### 3.4 The rule for adding one

From `AGENTIC-ENGINEERING.md:181-183`: prefer what is already in the repository;
add a dependency only for a concrete need, and explain the maintenance and
security cost. For this project that means naming, in the proposal:

1. the specific capability that is missing,
2. whether it can be written against the standard library instead,
3. the licence,
4. the new attack surface, and
5. how a green suite would still fail to catch a bad version.

A dependency that only serves a Planned section is not yet justified.

## 4. AI development

### 4.1 What exists today

| Surface | Entry point | Provider |
| --- | --- | --- |
| Terminal ask | `terminal221b ask --workspace .` | `ANTHROPIC_API_KEY` from the environment; `TERMINAL221B_MODEL` optionally selects a model |
| Terminal crypto ask | `terminal221b crypto ask` | same, with the crypto guidance prepended |
| Apply a proposed change | `terminal221b ask --apply` | same; writes nothing without approval |
| TUI | `npm run tui` | same, through a worker thread |
| Expo app | Settings → key, then the chat screen | user-supplied key sent directly to the provider |

`packages/cli/src/prompt.ts` is eight lines and is the entire crypto system
prompt. It is worth reading as a contract rather than as a string: it separates
verified facts from speculation, and it forbids personalized investment advice,
trades, transactions, wallet secrets, bounty-report submission, and remote
target testing in one sentence each.

`.env.example` carries the rule that makes the app's privacy claim true: the
app does **not** load secrets from the environment, `EXPO_PUBLIC_*` is never
used, and `ANTHROPIC_API_KEY` is documented as belonging to the terminal CLI.

### 4.2 `ask --apply` is a security boundary, not a feature

The shape is the point, and every step is tested:

1. The model returns a **unified diff** and nothing else.
2. Binary patches are rejected.
3. `path-guard.ts` checks **both** sides of every `diff --git` header: the path
   may not be empty, contain `"` or `\`, be absolute, contain a `..` or `.git`
   segment, land in a sensitive location (`.env*`, `.ssh`, `secrets`,
   `credentials`, or a `*.pem`/`*.key`/`*.p12`/`*.pfx` basename), escape the
   workspace root, traverse a symlink, or sit under a non-directory.
4. `git apply --check` runs before anything is written.
5. The operator must type `APPLY`.
6. **The model never gets a shell.** There is no path from model output to
   command execution anywhere in this repository.

The limit is stated in [TERMINAL221B-CASE-THREAT-MODEL.md](TERMINAL221B-CASE-THREAT-MODEL.md) as **F17**: this is
validation at a boundary, not an executor with an OS around it. A prompt cannot
enforce operating-system permissions, and neither can this code.

### 4.3 The provider boundary that does not exist yet

`TaskContract.role` accepts `scout`, `analyst`, `engineer`, `artist`,
`reviewer` — and today it is **a label and nothing more**. No prompt changes
based on it, no provider call changes, no output is shaped by it.

[README.md](../README.md) roadmap item 3 states the order of work, and the order is the
point: **evidence-backed agent profiles and a typed TUI/provider boundary must
land before role-specific prompts.** Building role prompts first would produce
five personalities over one untyped interface, and every one of them would be a
prompt with no test.

What "typed boundary" means concretely: one interface for "send a request,
get a response, report failure", implemented by the CLI, the TUI worker
thread, and the Expo service, so that a role profile is a parameter rather than
a fork.

### 4.4 The prompt framework contract

The framework is already written, in
[TERMINAL221B-AGENTIC-ENGINEERING.md](TERMINAL221B-AGENTIC-ENGINEERING.md). This section states how to use it,
not what it says.

**Work modes** (§142–175) are the entry point:

- **Explore** — read-only. Map implementation, data flow, interfaces,
  constraints, tests. Do not broaden. Keep investigation separate from
  implementation.
- **Plan** — for multi-step, cross-surface, risky, or architecture-level work.
  State the problem, the approach, affected components, dependencies,
  acceptance evidence, risks, and unresolved choices. Ask only for a decision
  that changes implementation.
- **Execute** — seven numbered steps ending in: *commit, push, open PRs, or
  merge only when explicitly authorized.* And: *do not silently lower
  acceptance criteria or label incomplete work complete.*

**The major proposal format** (§233–251) applies to significant product or
architecture decisions, not to routine changes: INNOVATION THESIS → KEY INSIGHTS
& ASSUMPTION SHATTERING → CHALLENGE DECONSTRUCTION → EXPLORATION MATRIX →
DEEP DIVE — SELECTED PATHS → IMPLEMENTATION ROADMAP (ordered testable slices,
not a feature cloud) → SUCCESS METRICS & LONG-TERM EVOLUTION (never invent a
threshold) → SELF-REFLECTION & OPEN QUESTIONS.

**Task handoff** (§253–258): result first, then changed paths, verification
actually run, known limitations, and the next useful slice only when one is
needed.

**The executable entrypoint** is `.github/skills/`, not this document:

- `terminal221b-engineering/SKILL.md` — the whole repository across its three
  surfaces. Its Source of truth clause is explicit: read
  [TERMINAL221B-AGENTIC-ENGINEERING.md](TERMINAL221B-AGENTIC-ENGINEERING.md) **from the checkout root**, do not
  resolve that path relative to the skill directory, code is authoritative, and
  if no checkout is available, say so rather than inventing project details.
- `terminal221b-tui-engineering/SKILL.md` — the Rust terminal interface only.

Use the skill for the contract and this guide for the map. They cannot drift in
a way that matters, because the skill points back at the source document.

### 4.5 What a prompt may never do

From `AGENTIC-ENGINEERING.md:213-231`, and these are enforceable-by-review
rather-than-by-code, so treat each as a hard rule:

- Never request, print, commit, or transmit API keys, seed phrases, private
  keys, tokens, or credentials. Never place secrets in `EXPO_PUBLIC_*`.
- Say when source or prompts go to a provider. Do not claim local-only
  behaviour for a request that transmits data.
- Do not execute model-generated commands, test remote bounty targets, submit
  vulnerability reports, trade assets, sign or broadcast transactions, take
  custody of a wallet, or request wallet secrets.
- If the product does not implement an action, do not simulate it and do not
  claim it.
- Keep the human operator as final authority.

## 5. TUI building

### 5.1 Module map, and what belongs in each

`packages/rust-tui/src/`:

| Module | Lines | Owns |
| --- | --- | --- |
| `main.rs` | 972 | the event loop, the renderer, and the app coordinator |
| `session.rs` | 498 | local transcript save / list / load |
| `workspace.rs` | 197 | bounded workspace selection, and the content-free `/context` preview |
| `prompt.rs` | 158 | pure prompt editing — Unicode-aware |

The design rule is a *pure core, explicit edges* split: logic that can be tested
without a terminal lives in `prompt.rs` and `session.rs`, and everything that
touches the filesystem, the provider, or the terminal stays at the edge.
`prompt.rs` is the model of this — pure text manipulation, no I/O, and therefore
testable without spawning a TTY.

**The honest state of `main.rs`:** the renderer and the app coordinator are both
still in it. That is recorded as a self-critique in [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md), and
it is the main structural debt in the TUI. Extract actions and view components
into independently testable modules as features justify it — not before.

### 5.2 The event-loop rule

From `TUI-ARCHITECTURE.md:11-20`, and this is the load-bearing architectural
decision for anyone building on the TUI:

- One terminal event loop updates application state and redraws Ratatui frames.
- **Keep I/O and provider work off the UI loop.** Provider requests and
  workspace previews run on worker threads and return through a channel.
- Prefer a **centralized event collector that dispatches events to focused
  handlers** over a separate event loop in each screen.

The failure mode the second and third rules prevent is specific: a single loop
that keeps becoming a monolith, where a slow provider call blocks the redraw
and the operator cannot interrupt. A screen that owns its own loop reintroduces
it per screen.

### 5.3 The session-storage contract

| Property | Value |
| --- | --- |
| Location | `$XDG_STATE_HOME/terminal221b/sessions`, else `~/.local/state/terminal221b/sessions`; `%LOCALAPPDATA%/terminal221b/sessions` on Windows |
| Permissions | directory `0700`, files `0600` on Unix |
| Writes | atomic |
| Name grammar | up to 48 characters, lowercase ASCII letters, digits, hyphen, underscore |
| Contents | user and assistant turns only |
| Excluded | system messages, workspace path, context, provider config, keys |
| Redaction | secret patterns are stripped — **heuristic, not a guarantee** |

Chat history in the Expo app is a different thing: AsyncStorage, and
**not encrypted** (see [SECURITY.md](../SECURITY.md)). The TUI's session store is the one with
`0600` and redaction. Do not describe them interchangeably.

### 5.4 The slash-command surface

`/crypto`, `/tools`, `/scan`, `/apply <request>`, `/save <name>`, `/sessions`,
`/load <name>`, `/context`.

`/context` is the disclosure control: it previews paths and byte sizes, and it
prints **no file bodies** and **makes no provider call**. If you add a command
that reveals content, you are removing a boundary, not adding a feature.

### 5.5 What is not built

The agent-role system is unimplemented, and `role` is a label (§4.3). There is
no streaming, no attachment handling, no cross-run session persistence in the
app, and no mobile model selection. [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md) also records the
product boundary: GitHub Sponsors is voluntary; do not add Stripe, trading,
wallet custody, or bounty submission.

## 6. Engineering architecture

### 6.1 Three surfaces, and the boundary between them

| Surface | Language | Owns | Must not own |
| --- | --- | --- | --- |
| Expo app | TypeScript / React Native | one chat screen, session history, native key storage | secrets from the environment, provider routing policy |
| `packages/cli` | TypeScript, zero dependencies | the case path, the store, scope validation, the security scan, `ask --apply` | rendering, terminal state, a network fetch of a case source |
| `packages/rust-tui` | Rust, edition 2024 | terminal interaction, local transcript I/O, the `/context` disclosure | parsing, the gate, signing — those are the CLI's, and duplicating them would be a second source of truth |

The CLI↔TUI relationship is worth stating: the TUI's `/scan` and `/apply` reach
the same pure functions the CLI uses, not a reimplementation. A rule enforced
once, in the CLI, and reused is enforced; a rule enforced twice is enforced
until one copy drifts.

### 6.2 Control versus cognition

Blueprint §3.1 and §3.3 own this. In one line: the deterministic code decides,
the model proposes, and the permission ladder decides how far a proposal may go
on its own. The ladder's existence is what makes `ask --apply` a reviewable
step rather than a `yes` prompt.

### 6.3 The trust boundary as implemented, not as designed

| Boundary | Enforced by | Limit it does not cover |
| --- | --- | --- |
| a declared writable path | `path-guard.ts` `assertDeclarablePath`, called from `parseTaskContract` — so `../../etc/passwd` **fails to parse** | the parser is sync, so the `lstat`/`realpath` segment walk cannot run; a symlinked parent still parses. **F17** |
| a patch path | `assertSafePath`, called from `validatePatchPaths` — full check including symlinks | the same finding: enforcement at a boundary, not an executor |
| who signed a record | detached ed25519 over `terminal221b/record-signature/v1\n{kind}\n{recordId}\n{payloadDigest}\n`; `putBundle` refuses unless every human record is `signed` | a signature names a key, not a person, and `signedAt` is caller-chosen. **F15** |
| whether a source really is what it claims | `local://` and `file:///abs` bytes are re-hashed at put, get, and verify | `https` and host-form `file://` are `unverifiable-here` and **never fetched**; no egress. **F16** |
| whether a stored bundle is the bundle that was signed | the digest recorded in `transitions.jsonl`, compared on every verify | — |
| eligibility | `evaluateEligibility`; the confirmation must carry a signature that verifies against a key the store trusts, or the case is `review` with `confirmation_unsigned` | the gate reads **only** confirmations and evidence. Approvals, outcomes, duplicate searches, and assessments are enforced at the store boundary, not here — a deliberate deviation, recorded as such |

`confirmation_signed` defaults to **false**. That is the fail-closed choice, and
it is why `case dossier` without `--store` prints a confirmed case as awaiting a
signature rather than as queued.

### 6.4 The verification doctrine, and the lesson it produced

The full command set is in `AGENTIC-ENGINEERING.md:195-207`. Two rules make it
more than a checklist:

- **Do not claim a command passed unless it was run on the current tree.**
- **Write the test that would fail if the rule were removed.** A test that
  holds by construction is not evidence.

Finding **F19** is the worked example and it is worth more than the rule
derived from it. The store's integrity check hashed the file it was checking
and compared the result with the stored value that had just been computed from
the same bytes. It could not fail. It survived a green 229-test suite, and was
caught only when an end-to-end script edited a stored bundle in place.

> A digest derived from the bytes under test compares equal to itself. A
> recorded digest is a *historical claim*; recomputing it and calling that a
> check proves nothing.

The same pass recorded F18 (the parser rejected its own derived `asset` field,
so a bundle could not be read back) and F20 (the store was keyed per case when a
bundle carries one scope and one policy snapshot for all its cases). All three
were found by *running* the store, not by reading it. That is the pattern to
copy: build the artifact, then try to break it end to end, and record what broke
as a numbered finding rather than as a quiet fix.

## 7. Designer surfaces: GUI and TUI

### 7.1 What a designer can actually change today

- **TUI layout, copy, and key bindings** — `main.rs`, `prompt.rs`,
  `workspace.rs`.
- **`/context` disclosure wording** — the one place the operator sees what
  would be sent.
- **Dossier markdown** — the `dossier` template and `renderDossier`, which
  prints eligibility, review reasons, evidence, and a "what this dossier does
  not do" list.
- **Store CLI output** — the human-readable lines `put`, `get`, and `verify`
  print.
- **Case template fixture** — `case template` prints a bundle built entirely
  from non-resolvable `example.invalid` URIs.

The visual language is fixed in `AGENTIC-ENGINEERING.md:67-68`: *a dark, precise,
high-signal Baker Street visual language. Avoid ornamental crypto-bro clutter.*
That is a constraint, not a suggestion.

### 7.2 The information architecture you inherit

Blueprint §5.1–5.3 own it. The rules that bind a design proposal:

- Every screen answers **exactly one operator question**. If a screen answers
  two, it is two screens.
- The global frame is fixed; a new surface either fits inside it or declares
  why it does not.
- Interaction contracts are part of the design, not a follow-up: what a key
  does, what a failure looks like, what is never shown.

### 7.3 Terminal constraints a design proposal must respect

| Constraint | Why |
| --- | --- |
| **Status is a word, never a colour alone.** Eligibility prints `ELIGIBLE`, `REVIEW`, `BLOCKED`, `NOT_EVALUATED`; a review prints the reason it waits on | colour-only status fails for a red-green deficiency and fails in a monochrome pipe, and a status is a security claim |
| **Every finding has a text-only form** — path, line, rule, severity. The security scan already reduces to exactly this and never prints a secret value | a scan that can print a secret has no findings worth reading |
| **80 columns is the floor** | a truncated integrity digest is not a digest |
| **Unicode-aware editing** is already in `prompt.rs`; do not regress it | it is a shipped, tested property |
| **Untrusted text is escaped, not stripped** — control characters are removed, the rest is escaped | a bundle field rendered raw into a terminal is finding **F3** |
| **A disclosure is a boundary** — `/context` shows paths and sizes, never bodies | same reason |

**The trust-surface principle:** anything the operator reads in order to decide
is a security surface. It must be evidence-shaped — a path, a digest, a
timestamp, a reason — and it must be falsifiable. A screen that makes the
operator *feel* informed is a bug, and the dossier's "what this dossier does
not do" section exists for exactly this.

### 7.4 Designer workflow spec **[new]**

Applies to a new screen, a new dossier section, and a change to any existing
operator-visible surface. Not started work — this is the contract a proposal
must satisfy before code.

1. **Operator question.** State the one question the surface answers. If you
   cannot, it is not a surface yet.
2. **Evidence shown.** Name every field, and for each, where it came from and
   whether it was recomputed or merely declared. A declared digest must be
   labelled as declared (see **F16**).
3. **Failure state.** What the operator sees when the check fails, when the
   source is missing, and when the signature does not verify. A failure state
   that is not designed is a failure state that will be wrong.
4. **Action.** What the operator can do, and what the approval gesture is.
   Anything with an external effect needs an explicit gate — the ladder in
   blueprint §3.3, not a `y`.
5. **The test that proves it renders.** For a TUI change, a test that fails
   without the change. A screenshot is evidence, not a test.
6. **What it does not do.** One sentence, in the surface itself. This is not
   documentation; it is the cheapest control in the project, and the dossier
   already models it.

For surfaces that do not exist yet, name them and mark them Planned:

- **Tauri desktop frontend** — [README.md](../README.md) roadmap item 2. [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md)
  is explicit that it is not part of this terminal release.
- **Textual research workbench** — blueprint Phase 2, and it is blocked on open
  decision 1 (§9.4): workbench or shell replacement? The two produce completely
  different information architectures, which is exactly why the question comes
  first.

### 7.5 What a designer must not add

No payment, trading, or wallet-custody affordance. No paid gate. No custody UI.
No auto-apply. No key display, no key input outside the platform keystore path.
No aggregate score, payout probability, or single-number ranking. No ornament
that costs legibility at 80 columns.

## 8. Smart contract tools

### 8.1 The declared profiles

`toolchains/tooling.json` is the source of truth: version 1, three profiles.
Each entry is a name, a binary, an install source, an optional official Arch
package or AUR package, and a documentation URL. `packages/cli/src/tools.ts`
carries the same list, and `terminal221b tools` reports **PATH presence only** —
it checks, and it does not install anything.

**security** — local repository review and source analysis:

| Tool | Install | Verify |
| --- | --- | --- |
| gitleaks | `officialArchPackage: gitleaks` | `gitleaks version` |
| trivy | `officialArchPackage: trivy` | `trivy --version` (needs a pre-cached vuln DB) |
| bandit | `pipx install bandit` | `bandit --version` |
| semgrep | `pipx install semgrep` | `semgrep --version` |
| slither | `pipx install slither-analyzer` | `slither --version` |
| cargo-audit | `officialArchPackage: cargo-audit`, or `cargo install` | `cargo audit --version` (needs a pre-cached advisory DB) |

**solana** — *local Solana/SVM development. Use a local validator or an
explicitly selected devnet; no wallet signing in Terminal221b.*

| Tool | Install | Verify |
| --- | --- | --- |
| solana | AUR `solana-cli`, or the official Anza installer | `solana --version` |
| anchor | Anchor Version Manager | `anchor --version` |
| avm | Anchor Version Manager | `avm --version` |

**evm** — local EVM contract build, test, and static analysis:

| Tool | Install | Verify |
| --- | --- | --- |
| forge | Foundry upstream installer, **release hashes verified** | `forge --version` |
| cast | bundled with Foundry | `cast --version` |
| solc | a user-reviewed package, or `pipx install solc-select` then select a version | `solc --version` |

### 8.2 Arch-specific notes

`packages/cli/resources/omarchy-toolchain-plan.sh` exists for this and is
**dry-run only**: it refuses a non-Arch `/etc/os-release`, requires `pacman` on
`PATH`, prints which of `gitleaks trivy cargo-audit` resolve in an enabled
official repository, and prints the `pacman -S --needed` line as *text*. It
never installs, never runs `sudo`, never builds an AUR package, and never
executes an upstream installer. Run it as `terminal221b setup omarchy --dry-run`.

Two judgement calls it makes explicit, and they are the ones to keep:

- If `solana-cli` resolves in an **official** repository, it says to *verify its
  identity before use*. If it does not, it is an AUR candidate and the
  instruction is to inspect the PKGBUILD and the source checksums **before**
  `makepkg`.
- The Foundry installer is the only one noted as verifying release hashes. That
  asymmetry is deliberate.

### 8.3 What the code wires today

- `terminal221b security scan --workspace .` plus
  `--with-gitleaks --with-bandit --with-semgrep --with-trivy --with-slither
  --with-cargo-audit`. Findings reduce to **path, line, rule, severity** and
  never print a secret value. Each tool is opt-in by flag; the CLI does not
  invoke a tool that was not asked for.
- Trivy needs a pre-cached vulnerability database, and `cargo audit` a
  pre-cached advisory database. A scan that silently degrades because a database
  is missing is worse than one that refuses, so check this before believing an
  empty result.
- `npm run lint:shell` runs `shellcheck` over `packages/cli/resources/*.sh`, and
  `packages/cli/resources/semgrep.yml` is the Semgrep ruleset the `--with-semgrep`
  path uses.
- **The gap, stated plainly:** `slither` is declared in `toolchains/tooling.json`
  and reachable through `security scan --with-slither`, but nothing in the
  case path invokes it. Declared-and-wired is not the same as integrated; treat
  slither as "runs when you ask", not as "part of the gate".

### 8.4 The hard boundary

Stated in the profile description, blueprint §9, and [TUI-ARCHITECTURE.md](TUI-ARCHITECTURE.md)'s
product boundary, and it is not a default to be revisited casually:

- Local validator, or a devnet the operator **explicitly selected**.
- **No wallet signing in Terminal221b.** No custody. No transactions. No trades.
- No remote target testing, and no bounty-report submission.
- No personal investment recommendations.
- Blueprint open decision 6 asks whether *any* wallet-facing workflow belongs
  here at all; the recorded default is no custody, and signing stays outside
  the app. That question is open, and Phase 6 does not answer it.

### 8.5 Planned read-only smart-contract integration **[new]**

**Status: Planned. Blueprint Phase 6+, and it is the first phase that would
emit `authorization_unknown`, the first that could egress, and the first that
could turn `unverifiable-here` into a recomputed digest.** None of this exists.

The design, so that it can be argued with rather than discovered:

**Step 1 — intake.** A program or contract address arrives as a **candidate
asset**, never as a scope. The scope gate is not extended to accommodate it. An
address is an identity claim; the scope manifest is an authorization record, and
conflating them would let a string assert its own permission.

**Step 2 — resolve identity.** Read the address from an explicitly selected
local validator or devnet. Record what was read and where from, as a
`SourceRecord` with `kind` and `observedAt`. Nothing is fetched silently.

**Step 3 — fetch to a content-addressed cache.** Bytes land under the store's
`objects/` scheme, **outside the repository**. The default store root is
`$XDG_DATA_HOME/terminal221b`, or `~/.local/share/terminal221b` — the same
reason it defaults there today, which is that a repository-local store would
show up in `git status`.

**Step 4 — hash and record.** This is the whole point of the phase. The
`SourceRecord`'s `contentDigest` is computed from the cached bytes, the uri is
`local://`, and the **existing** `putBundle` path then re-hashes those bytes on
every put, get, and verify. The gate tightens from a declared digest to a
recomputed one without a line of new verification code — **F16** moves from
unclosable to closed for exactly the sources that went through this path, and
stays open for everything else.

**Step 5 — analyse locally.** `slither <path>`, `forge build`, `cargo audit`:
local, on the cached path, under a new explicit CLI verb with the same approval
gesture as `ask --apply`. **The tool never receives a network target.** A
scanner pointed at a remote address is remote target testing, which is
forbidden, and the verb's contract is that it takes a local path.

**What it may not do:** sign, broadcast, submit a report, contact a target,
fetch an asset the operator did not name, or produce a finding whose bytes
cannot be pinned to a recomputed digest.

**The kill criterion:** if fetched bytes cannot be pinned to a digest the store
recomputes, the finding stays `unverifiable-here`, the phase does not graduate,
and the honest output is a counted unverifiable source rather than a confident
finding. The `authorization_unknown` block reason becomes emittable for the first
time here, and emitting it is the correct behaviour, not a defect.

**Open decision 2** (which bounty sources are authorized, legal, and useful)
blocks this phase and cannot be answered by engineering.

## 9. Integration plan

### 9.1 Phase order, with the gate each phase must pass

| Phase | Integrates | Gate | Binding constraint | State |
| --- | --- | --- | --- | --- |
| 0. Contracts and fixtures | `case.ts`, `case-fixtures.ts` | 49 schema and reduction tests, `validateCaseBundle`, three threat-model passes | — | **Done** |
| 1. Explainable local dossier | the eligibility gate, ordinal vector, manual program snapshot, markdown export, the local case store, retention enforcement | schema tests, provenance invariants, threat-model review — all three pass | **the isolated worktree for the Engineer adapter (F17, Phase 3)** — the retention policy is answered | **Partially done** |
| 2. Textual usability probe | a second operator surface | the §7.4 designer spec, satisfied in one screen | ~~open decision 1~~ — answered; the first screen is the case dossier | **Done (2026-10-02)** — the dossier screen satisfies all six §7.4 items. The question had one owner (`operatorQuestion` in the payload, F23 closed); "source is missing" is designed rather than a raw ENOENT; `attested` replaces a misleading `signed`; `verification` is labelled the bundle's assertion. 60 cargo tests, and the screen's assertions run through the real `draw` |
| 3. Engineer adapter | a provider adapter, an executor, an isolated worktree | a task that runs, fails visibly, and leaves a reviewable change | **F17** — no executor, no OS isolation | Not started |
| 4. Analyst / Artist handoffs | the Handoff object across roles | evidence-backed agent profiles exist first | the `role` field is still a label | Not started |
| 5. Outcome accounting | the outcome record and its signature | an outcome can be written, signed, and read back | nothing records an outcome yet | Not started |
| 6. Read-only external sources | §8.5 | a finding pinned to a recomputed digest | **F16**, and the first egress | Not started |

Phase 1 does not graduate, and there is now **one** reason where there were two.
Retention enforcement shipped, and its policy is answered (7 / 180 / 180 days,
archive never). What remains is the isolated worktree for the Engineer adapter,
which is Phase 3 and finding F17.

### 9.2 The sequencing rule

From blueprint §11: do **not** start by implementing all three trinity agents
plus a plugin marketplace plus a generalized autonomous loop plus a chain
integration. The smallest valuable vertical slice is *local bounty dossier +
scope freshness gate + evidence-linked ordinal ranking + explicit owner
review* — and that slice is almost finished. Retention enforcement has since
shipped, so the next slice is the isolated worktree, not a new surface.

### 9.3 The seams, and the one that does not exist

| Seam | What crosses it | State |
| --- | --- | --- |
| CLI ↔ store | `case store init \| put \| get \| verify`, the check order, the durable write under a lock | **Shipped** |
| TUI ↔ CLI | `/scan` and `/apply` reach the same pure functions the CLI uses | **Shipped** |
| bundle ↔ dossier | the `confirmationSigned` predicate the CLI injects from the store manifest; absent, the gate stays shut and a confirmed case reads as awaiting a signature | **Shipped** |
| contract ↔ provider | `ProviderResult` and `ResultEnvelope`, one clause vocabulary rendered from one file by the CLI and the TUI | **Shipped — `provider.ts`, `system-prompt.ts`, `boundary.rs`** |
| provider ↔ Expo app | `ProviderFailure` imported as a type only, a real `AbortController` timeout, and no catch-all in `ClaudeService.ts` | **Shipped — F24 closed** |
| contract ↔ executor | nothing. `writablePaths` is validated at parse and **no code acts on it** | **Does not exist — F17, and it is the Phase 3 gate** |

The **last** row is the single most important line in this guide. Every
`writablePaths` declaration in every bundle is currently a *statement of
intent*, checked for plausibility and never executed. The two boundary rows
above it are the prerequisite for closing this one: once a request can be typed
and a failure can be named, an adapter can be written that refuses to act on a
path the guard rejected. Both are now shipped, so the boundary is on all three
surfaces and the executor is the only thing standing between this table and a
Phase 3.

### 9.4 Open decisions, and the phase each one blocks

From blueprint §13, whose closing instruction is *resolve only the decision the
next phase needs*:

| # | Decision | Blocks |
| --- | --- | --- |
| 1 | Research workbench, or shell replacement? | Phase 2 |
| 2 | Which bounty sources are authorized, legal, and useful? | Phase 6 |
| 3 | What outcome data may be retained, for how long, and where? | Phase 5, and Phase 1's graduation |
| 4 | What counts as an independently verified finding, per program? | Phase 3 |
| 5 | What do providers and tools actually cost, in money and in operator time? | Phase 4 |
| 6 | Does any wallet-facing workflow belong here? Default: no custody | Phase 6 |

### 9.5 Cross-cutting rules that outlive any phase

- **Keep F15, F16, and F17 closed** before the store accepts a bundle from an
  untrusted source. A signature names a key, not a person; only local digests
  are recomputed; and there is no executor behind a declared writable path.
- **Record the retention policy** before Phase 1 graduates. The mechanism now
  exists and F10 is closed; what is missing is a decision about how long each
  class may be kept, so the windows are operator input rather than a default.
- **Give the Engineer adapter an isolated worktree**, before it has a shell.
- **No weighted scores, payout probabilities, or aggregate ranking numbers.**
  The ordinal vector exists so that a reader can see which factor moved.
- **Never order version strings** to decide which policy snapshot is current
  (finding F14).
- **Record ids share one global namespace** (F9). That is a design decision;
  do not "fix" it.

## 10. Where to start

Five slices, in order, each with the command that proves it. Slices 1 and 2 are
shipped. Slice 3 was moved to the front of the remaining plan after a judgment
pass rated the previous ordering "acceptable but not optimal": a provider request
with no timeout can hang until the platform gives up, so the one surface not yet
on the boundary goes before anything that is only a taste question.

### Slice 1 — retention enforcement (mechanism and policy both shipped 2026-10-02)

**Done, except for the policy.** `retentionReport` and `purgeExpired` are in
`store.ts`, exposed as `case store retention`, and the threat model's F10 is
closed with the residual recorded as F21. The gate run is 211 tests.

What shipped: every stored source is aged against the window its class carries,
a class with **no configured window** reports `unconfigured` rather than being
treated as safe to delete, a purge requires a token the report printed, a purge
removes a whole revision rather than a record so no surviving signature is
falsified, and the newest revision is never purgeable so the store always keeps
something current.

What is **not** done is the actual policy. How long each class may be kept is
open decision 3, so the windows are operator input:

```sh
terminal221b case store retention --store DIR \
  --case-metadata-days 30 --transient-days 7 --local-diff-days 14
```

Decision 3 is answered (2026-10-02): `transient` 7d, `case_metadata` 180d,
`local_diff` 180d, `operator_archive` never. The windows live in the operator's
own `retention.json`, recorded with `--record-default-policy`, so nothing is
expired until the operator has written the file. A class with no window still
reports `unconfigured` and is still not purgeable. **Phase 1 stays Partially
done for one reason now, not two:** the isolated worktree for the Engineer
adapter, which is Phase 3 and F17.

Accept, already satisfied: `npm run lint && npm test && npm run typecheck && npm run build:cli`
plus the 19 retention tests in `store.test.ts`, and an end-to-end run in
`/tmp/t221b-ret*.sh` covering report → blind-purge refusal → purge → post-purge
`verify` → token replay refusal.

### Slice 2 — a typed provider boundary (boundary only)

**Done. No role profiles, and that is the point.** The boundary landed; the
profiles did not. Writing them before the boundary had proved itself would have
produced five personalities over an untested interface.

What shipped:

- `packages/cli/src/provider.ts` — `ProviderRequest` / `ProviderResult` and
  `ProviderFailure` as a **discriminated union**: `missing_key`, `network`,
  `timeout`, `http_error`, `invalid_json`, `no_text_block`, `cancelled`,
  `unsupported_capability`, `schema_mismatch`. Never a message string, per
  blueprint §6.4's *"distinct visible outcomes, never an empty successful
  response"*. `describeFailure` renders one human line **from** the typed value
  and `exitCodeFor` branches on the kind, so a script never parses English.
- `packages/cli/src/system-prompt.ts` and
  `packages/cli/resources/provider-boundary.json` — a system prompt is an
  **enumerable profile of named clauses**. All 18 clauses map one-to-one onto
  the "a prompt may never" list in
  [TERMINAL221B-AGENTIC-ENGINEERING.md](TERMINAL221B-AGENTIC-ENGINEERING.md)
  §"Security, sovereignty, and financial boundaries", so a profile is auditable
  by reading names rather than by reading prose and hoping.
- **The drift fix (F22).** The crypto prohibitions used to be a *system prompt*
  in the TUI and *user text* in the CLI — the weaker copy, and the one anyone
  running `crypto ask` actually received. Both surfaces now render from the one
  file, so a clause cannot exist on one side and be missing on the other.
- `packages/cli/src/envelope.ts` — blueprint §3.2's `ResultEnvelope` and
  `AgentEvent`, validated so an unknown version, a bad instant, or a non-integer
  token count fails closed and stays visible.

**The guard is proven, not asserted.** `boundary-drift.test.ts` and
`boundary_drift.rs` each mutate a copy of the real file with a prohibition
removed and assert the renderer notices, each carrying a control that asserts
the unmutated file still has it. A guard that has only ever run green has not
been shown to fire.

**F17 stays open.** The boundary sends a request and reports a result. It
executes nothing, invokes no tool, and acts on no `writablePaths`. The
contract-to-executor seam in §9.3 is still the one that does not exist.

**What is not done:** no role profile. That is **Slice 4** below. The Expo app
adopted the boundary in **Slice 3**, closing F24.

### Slice 3 — F24: the Expo app adopts the boundary (reordered to first) — **Done**

**Done.** `src/services/api/ClaudeService.ts` now sends a real `AbortSignal`
timeout and returns a typed failure instead of a collapsed string. The seam
table's second `Does not exist` row is closed, and the boundary is on all three
surfaces.

**Why this moved to the front of the remaining plan.** A judgment pass rated the
previous ordering "acceptable but not optimal" and put this surface first at
0.84, for the reason that is also the obvious one: a request with **no timeout at
all** could hang until the platform gave up. Everything else waited behind that.

What it sent before: `fetch` with **no `signal` whatsoever**, ending in a
`catch` that turned anything which was not an `Error` into the single string
`Failed to send message to Claude API`. A refused connection, a timeout, a
cancelled request, and a malformed body were indistinguishable. Blueprint §6.4
requires them to stay distinct.

What it does now:

- **A real timeout.** `timeoutSignal()` builds an `AbortController` and a
  `clearTimeout`-cancelled timer by hand. `AbortSignal.timeout` was deliberately
  not used: it does not exist in every React Native runtime this app may ship
  to, and an uncancellable request is the entire subject of the finding.
- **No catch-all.** The transport catch returns `timeout` when the signal fired
  and `network` with the cause otherwise, and a non-`Error` throw is typed
  rather than discarded. An unparseable error body keeps its HTTP status instead
  of vanishing. A success body that is not JSON is `invalid_json`, not
  `no_text_block`.
- **Never an empty success.** A whitespace-only text block is a refusal. The old
  code returned `''` and the caller rendered a blank assistant turn.
- **One vocabulary, not a copy.** `ProviderFailure` is imported from
  `packages/cli/src/provider.js` **as a type only**, so the three surfaces
  cannot drift — the compiler enforces it. A *value* import would have dragged
  `system-prompt.ts` → `node:fs` into the React Native bundle, which fails at
  runtime rather than at build; that is why the renderer is duplicated, and it is
  **F25**. `validateApiKey` returns the typed failure rather than a bare
  `false`, because a boolean is the same collapse this slice exists to remove.

**Both halves are proven by mutation, not assertion.** Reintroducing the missing
`signal` fails 2 tests; reinstating the catch-all fails 3, including "a timeout is
a timeout". A control test reads the source and fails if either is removed, so the
guard cannot go quietly green — the lesson F19 taught, applied before it was
needed.

Accept, satisfied: `npx vitest run` at **315 tests across 17 files**, lint,
typecheck, `build:cli`, `cargo test` at 34, clippy `-D warnings` clean, and
`ACCEPT_EXIT=0`.

### Slice 4 — one `analyst` role profile, changing no behaviour — **Done**

The boundary prerequisite is met on all three surfaces. Write `analyst` and
nothing else — `scout`, `engineer`, `artist`, and `reviewer` stay labels.

**The constraint that made it safe:** the profile changed **no existing
output**. Today's CLI output was the regression test. If adding the profile
altered what a command printed, the profile would be wrong, not the output. A
judgment pass put "safe only under that constraint" at 0.30 against a bare 0.45
for "safe now", and the constrained half was the half worth honouring.

**Four artifacts landed.**

1. **One clause, one profile, one file.** `provider-boundary.json` gained
   `no_patch_proposals` — *"Do not propose patches or code changes; report
   findings and evidence instead."* — appended to `clauseOrder`, and an
   `analyst` profile of 14 clauses that omits `patch_format` and adds
   `separate_facts_from_assumptions` and `no_remote_target_capability`. Because
   the renderer filters `clauseOrder` by profile membership, a clause no other
   profile names **cannot** reach the coding or crypto prompts. That is
   structural, not a promise: coding still hashes to `118994e4…` and crypto to
   `94c33a2c…`, byte-identical before and after.

2. **The role became a parameter.** `ROLE_PROFILES` is a total
   `Record<AgentRole, SystemProfile>`, so a sixth role without a decided profile
   is a compile error rather than a label by omission. `profileForRole(undefined)`
   is `'coding'`, which is what the call site resolved to before the table
   existed.

3. **One new way to reach it:** `terminal221b ask --role analyst PROMPT`. The
   other four roles are accepted and map to `coding` — the `--help` line says so
   rather than implying support that is not there. `crypto ask --role` **refuses**:
   two profiles would apply and the quiet resolution loses one of them.

4. **The guards both grew.** TS: `role.test.ts` (12 tests) and +5 on
   `system-prompt.test.ts`, including one that fails if a clause is declared but
   missing from `clauseOrder`, which is the only thing that catches a silent
   drop on both implementations. Rust: +3 in `boundary_drift.rs`, no source
   change — the mirror needed no new vocabulary.

**How "load-bearing" was proven, not asserted.** Three layers. Behaviourally,
`role.test.ts` intercepts the request and shows the `system` field differs by
role. By **mutation**: making `profileForRole` return `'coding'` regardless
failed exactly two named tests — `changes the system text actually sent when
the role changes` and `would fail if profileForRole ignored its argument`. And
from the built binary, intercepting a live request: `ask` sent 633 bytes of
system text (today's coding, unchanged), `ask --role analyst` sent 755 with the
new prohibition and no `patch_format`, `ask --role engineer` sent 633 again, and
`crypto ask` sent 955 (today's crypto, unchanged).

**What is not done:** four of five roles still select the coding profile (F26),
and the role vocabulary is duplicated from `case.ts` rather than shared (F27) —
`AGENT_ROLES` is not exported and `case.ts` was out of this slice's scope. No
executor, no tool invocation, nothing acting on a declared `writablePaths`.
**F17 stays open** and stays the Phase 3 gate.

### Slice 5 — record open decision 1, then build one Phase 2 screen

**Recording the decision costs no code** — a judgment pass put "this is a pure
design and information-architecture decision that needs no new code" at 0.95, and
it is not blocked on F24 or on open decision 4. So write the decision down first,
as a workbench: multiple panes in Ratatui, a case open alongside its evidence and
its scope, answering *which cases are actionable, why the rest are held, and what
would unblock each*, over the collection rather than one subject at a time.

It is a **workbench, not a Python Textual app** — `TUI-ARCHITECTURE.md` already
rejected that framework, along with TS+OpenTUI, TS+Ink, Go+Bubble Tea, and direct
Crossterm, in favour of the existing Rust and Ratatui pair. The blueprint's
"Textual" means the concept.

Then build exactly one screen, the case dossier, against §7.4: one operator
question, evidence named and labelled recomputed-or-declared, a designed failure
state, the approval gesture, a test that fails without the change, and a "what
this does not do" line.

**F17 stays open throughout.** No executor, no tool invocation, nothing acting on
a declared `writablePaths`. The contract-to-executor seam does not exist and is
not built by any slice in this plan.

---

**Final reminder, from `AGENTIC-ENGINEERING.md:24`:** verify before claiming.
This guide's Planned sections are designs, its Shipped sections name the command
that measured them, and where it is silent that is because a third document owns
the detail.
