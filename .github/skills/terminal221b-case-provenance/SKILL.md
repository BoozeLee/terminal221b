---
name: terminal221b-case-provenance
description: Work on Terminal221b's case store provenance chain — ed25519 signatures, content digests, attestations, and the eligibility gate. Use when touching packages/cli/src/store.ts, AttestedRecord, ConfirmationRecord, the bundle format, or the dossier/ranking screens that read it. Read this before changing any type in that file.
---

# Terminal221b case provenance

## What this chain is

The case store exists because a claim about who decided something, and a digest
about what was decided, were both **strings inside the file they were supposed to
vouch for**. Anyone who could edit the JSON could edit both. The fix is a second
channel: bytes the store computes, and a signature over a canonical form computed by
someone holding a key.

That chain is the security core of the CLI. Findings F4 and F5 are its two load-
bearing repairs, and the residuals they leave behind — F15 and F16 — are where the
remaining risk actually lives.

## Source of truth

- `packages/cli/src/store.ts` — the store, the types, signing and verification.
- `packages/cli/src/case.ts` — the bundle shape and contracts.
- `docs/TERMINAL221B-CASE-THREAT-MODEL.md` — findings **F1 to F27**.
- `packages/cli/tests/store.test.ts` (101 tests) — the store's own suite.
- `docs/TERMINAL221B-CASE-STORE.md` — the format.

**The threat model has 27 findings, F1–F27. It stops at F27, and that is not a gap
in the work.** F28 (the two-language `dossierReport`/Rust-reader contract) and F29
(the screen must never re-derive the gate) were specified by number in September
2026 and never minted as standalone findings. Both conditions are implemented and
documented under other numbers:

- The **F28** condition is the second instance recorded under **F23**, found and
  closed 2026-10-02 — the operator question was a Rust constant while the markdown
  export had no equivalent. It is now a required `operatorQuestion` field with
  `REPORT_VERSION` 2, and `dossier.test.ts` fails if Rust grows its own constant.
- The **F29** condition is the contract at the top of
  `packages/rust-tui/src/dossier.rs`: *"a reader, never a judge."* It is
  **structurally** enforced, not merely documented — the module imports only
  `std::process::Command` and `serde::Deserialize`, so there is no import path from
  the Rust screen to the TypeScript eligibility gate. The report arrives whole over
  `terminal221b case dossier PATH --json`; the screen decides only layout.

A cross-reference note recording this sits under **F22** in the threat model. So if
a document or a conversation refers to F28/F29, it refers to conditions that are
already covered — not to missing security work, and not to sections that exist.

## The signing contract, and where it lives

- `node:crypto` ed25519. `algorithm: 'ed25519'` is fixed at `store.ts:461`.
- The signed bytes are **domain-separated, newline-framed, with a fixed field
  order** (`store.ts:441`). Field order is part of the contract, not an
  implementation detail — reordering the fields changes the bytes and invalidates
  every existing signature.
- `attestationPayload` (`store.ts:432`) and `payloadDigestOf` (`store.ts:437`) are
  the two functions that decide what is covered.
- `verifyRecord('confirmation', …)` and `verifyRecord('approval', …)`
  (`store.ts:541`, `store.ts:558`) are the gate.

## The type you must understand before editing

`AttestedRecord` (`store.ts:125`) is **deliberately minimal**:

```ts
export interface AttestedRecord {
  version: 1;
  attestation?: Attestation;
}
```

Kind-specific identifiers are **not** in the type. They live in a runtime map,
`ID_FIELD` (`store.ts:130`), and are reached through a cast;
`recordsOfKind` (`store.ts:154`) erases the concrete bundle field with
`as unknown as`. That erasure is not laziness — it is the narrowing that keeps
every consumer from depending on a shape the attacker also controls.

**The unresolved fork.** `packages/cli/tsconfig.test.json` surfaces six type errors
where tests reach past that boundary: `store.test.ts(157,7)` `'statement'`,
`(259,51)` `'approvalId'`, `(262,58)` `'searchId'`, `(463,20)` a
`ConfirmationRecord` mismatch, plus `ranking.test.ts(4,3)` and
`dossier.test.ts(241,18)`. This was adjudicated and returned **`escalate to a human`**
(0.72, against 0.20 for fixing the tests and 0.01 for widening the type).

**So: do not fix these six errors, and do not widen `AttestedRecord`, without a human
decision.** Widening the type to satisfy a test is the option that scored 0.01 — it
undoes a narrowing that sits directly on the signature and digest path. The gate is
wired in CI as `typecheck-tests` with `continue-on-error: true`; its exit code of 2
is the documented state, not a regression. Remove the `continue-on-error` in the same
commit that makes it green.

## Rules

1. **Never hand-roll the canonical form.** If you need different bytes signed, change
   the function that produces them and re-derive — do not assemble a signing payload
   at the call site. The two-language drift this repository already suffered once is
   exactly that bug.
2. **Do not add a field to a record without deciding whether it is covered by the
   signature.** An uncovered field is F5 again, wearing a new name.
3. **Ephemeral keys in tests.** Generate an ed25519 keypair inside the test, sign the
   fixture, and assert the round trip. No committed private key, and no test that
   depends on a real one.
4. **The store's limit is stated in the threat model, so state it too.** F4 makes a
   human act attributable to a *key*, not a *person*: anyone who can read the private
   key file can produce a signature the store accepts, a shared key names nobody, and
   `signedAt` is caller-chosen so a signature can be dated after the fact. Do not
   describe a signed record as proof of a human identity.
5. **Unsigned human records are a review reason, never eligible.** Fail closed.

## Follow the drift guard's standard

`packages/rust-tui/src/boundary_drift.rs` states the bar this repository holds
itself to, and it is worth quoting rather than paraphrasing:

> A guard that has only ever run green has not been shown to fire, and a guard with
> no control proves nothing when it does.

It takes the real boundary file, removes a prohibition from a profile, and asserts
that **both** the Rust renderer and the TypeScript renderer notice. A test that reads
the file itself would pass on a machine where the binary was built from a different
copy.

Any new provenance guard owes the same: a control case that must fail, and proof that
it fails. A test that cannot fail is worse than no test, because it reads as coverage.

## Commands

```sh
npm test                                              # the whole suite; store.test.ts is 101 of the 385
npx vitest run packages/cli/tests/store.test.ts \
  packages/cli/tests/ranking.test.ts \
  packages/cli/tests/case.test.ts \
  packages/cli/tests/dossier.test.ts                 # the four-file provenance gate
cargo test --workspace --locked                       # boundary_drift must still pass
```

```sh
npm run typecheck:tests    # expected exit 2 — the six escalated errors. Documented state.
```

## What not to do

- Do not add trading, wallet custody, blockchain transactions, bounty-target
  testing or submission, or paid feature gates.
- Do not execute model-generated commands, or request wallet or provider secrets.
- Do not push, publish, or change repository settings unless explicitly asked.
