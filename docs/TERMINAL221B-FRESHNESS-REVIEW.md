# Freshness review

The Phase 1 gate in [TERMINAL221B-SYSTEM-ARCHITECTURE.md](./TERMINAL221B-SYSTEM-ARCHITECTURE.md)
asks for an "exact-freshness review". This is that review. It states what the freshness
check in the code actually computes, where it is exact, and where it is only an
assertion, so an operator can tell how much the `freshness` factor is worth before
relying on it.

## What the code measures

For a case, the policy snapshot is the `SourceRecord` named by
`CaseRecord.policySnapshotId`. Freshness is the age of that one record:

```
ageDays = floor((Date.parse(evaluationNow) - Date.parse(snapshot.observedAt)) / 86_400_000)
```

Implemented in `daysBetween` in `packages/cli/src/ranking.ts`; both inputs are parsed by
the `instant` validator in `packages/cli/src/case.ts`, which requires
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$` and rejects anything `Date.parse` cannot read.
There is no time zone arithmetic, no calendar arithmetic, and no local time anywhere in
the computation. `evaluationNow` comes from `--now` or, when absent, from
`new Date().toISOString()` in `showCaseDossier`.

## The boundary is exact and it is one-sided

A snapshot is **stale** when `ageDays > policyMaxAgeDays`, and fresh when
`ageDays <= policyMaxAgeDays`.

- The comparison is `>`, not `>=`. A snapshot exactly at the limit is fresh.
- `floor` means a partial day counts as zero. A snapshot 90 days and 23 hours old
  reports 90 and passes a 90-day limit; the next whole day reports 91 and fails.
- The limit is supplied by the operator (`--policy-max-age-days`, default 90). Nothing
  in the repository knows any program's real cadence, so the default is a working
  default and not a policy rule. `terminal221b --help` says so.
- A **negative** age is possible: a snapshot recorded with an `observedAt` in the future
  relative to `--now` yields a negative number, which is not stale. The code does not
  reject it. This is a known gap, listed below.

## The version guard, and what it does not do

`policyVersionProblems` in `packages/cli/src/case.ts` reports a provenance problem when
two `policy_snapshot` sources share a `policyVersion` string but have different
`contentDigest` values. The rationale is that a version string is a label, not an
identity: if two documents claim the same label and differ, then something edited one of
them behind an unchanged label, and anything keyed on the label is unreliable.

The guard deliberately does **not** compare version strings to decide which snapshot is
newer. `2026-09` and `2025-01` are not ordered by any rule this code should invent, and
an attempt to compare them would produce a confidently wrong answer on formats like
`v3.10` versus `v3.9`. Freshness therefore comes from `observedAt` alone, and the
version guard only reports the contradiction. Deciding which of two contradicting
snapshots is current is a human act that needs both documents.

## The limit of the whole check

**`observedAt` is operator-recorded. Nothing in this repository verifies it.**

The digest on the source record is shape-validated only: `contentDigest` must match
`sha256:[0-9a-f]{64}`. It is never recomputed from anything, because the bytes the
digest was taken over are not stored in the bundle. So a bundle can carry a digest that
is well-formed, meaningless, and unrelated to the document it names, and the code has no
way to tell. The same is true of `observedAt`: recording that you read a policy on a
given day is an assertion, and a wrong one silently makes a stale policy look current.

Consequence for how much the factor is worth: `freshness: high` means *the operator
recorded reading a policy recently*, not *the policy is current*. It is a statement about
the operator's own record-keeping, and it is only as good as that record-keeping. The
dossier says this on every factor row ("observedAt is operator-recorded, not
corroborated") and again in its closing list, so the claim cannot be read as more than it
is.

## A checklist before trusting the freshness gate

1. Open the recorded `SourceRecord.uri` yourself. If the URI does not resolve, the
   snapshot is a fiction and everything derived from it is too.
2. Recompute `contentDigest` over the document you fetched and compare it with the
   recorded value. This is a manual step; the code does not do it and cannot.
3. Check `observedAt` against your own record of when you fetched the document. If you
   cannot corroborate the date, treat `freshness: high` as `unknown`.
4. Check for a version-contradiction problem in the dossier's provenance section. If one
   is present, resolve which document is current before reading any freshness level.
5. Confirm the program has not announced a cadence that is stricter than the limit you
   passed. The 90-day default is not a program rule.
6. Re-run the dossier with `--now` set to a date you choose, not the wall clock, when
   you are reviewing a bundle that was built earlier. Otherwise every age drifts.

## Known gaps in this check

- **A future `observedAt` is not rejected.** A bundle can claim a snapshot was read next
  week and pass the gate. There is no upper bound on the age other than "not negative".
- **Digests are never recomputed.** Noted above; unfixable without storing the document
  bytes, which the retention design deliberately avoids.
- **The version guard is bundle-local.** It only sees snapshots present in the same
  bundle. A contradicting snapshot held in another bundle is invisible.
- **No cadence is known.** The limit is one number for every program, and the right
  number differs per program and over time.

## What was run

- `npx vitest run packages/cli/tests/case.test.ts packages/cli/tests/ranking.test.ts` —
  102 tests pass, including `blocks a stale policy snapshot and reports its age`,
  `reports a missing snapshot as a missing snapshot, not a missing scope`,
  `says the freshness timestamp is operator-recorded`, and
  `flags two snapshots that share a version string but differ in content`.
- `node packages/cli/dist/cli.js case dossier <bundle> --now 2026-09-30T12:00:00Z
  --policy-max-age-days 90` — renders the fixture bundle with the boundary above
  applied to every case.
