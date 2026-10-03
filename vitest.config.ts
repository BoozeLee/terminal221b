// The suite ran on Vitest defaults until this file existed, which meant the set
// of files that get tested was decided by a glob nobody wrote down. This pins
// that set explicitly and nothing else: same includes the default resolve already
// produced, so this file cannot add or remove a test by accident.
//
// If you add a test file outside these globs it will not run. That is the point —
// a test that is never executed should be a visible omission, not a silent pass.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'packages/cli/tests/**/*.{test,spec}.ts'],
    // Deterministic ordering. Vitest otherwise schedules by file size, which is a
    // heuristic that changes as the suite grows; a red that only reproduces on a
    // cold cache is a red nobody can reproduce.
    sequence: { shuffle: false },
    // No silent skipping. `executor.test.ts` has six `it.skipIf(!HAS_BWRAP)`
    // cases that do nothing where bubblewrap is absent, and the run still reports
    // success. This file does not assert a floor on that count, because a config
    // file that judges the tests is edited by the same change it judges. The
    // assertion belongs in CI (roadmap phase 1), where a reviewer sees it change.

    // COVERAGE LIVES UNDER `test`, NOT AT THE TOP LEVEL.
    //
    // A top-level `coverage` key is silently ignored by Vitest. That is not
    // hypothetical: this block sat at the top level first, and the run reported
    // 90.20% instead of 75.68% — because the include was not applied, so the
    // 794-line untested `cli.ts` dropped out of the denominator. A coverage gate
    // that reports a better number when it measures less is worse than no gate.
    // If coverage is ever moved up a level, expect the number to jump and check
    // `cli.ts` is still in the table before believing it.
    coverage: {
      provider: 'v8',
      include: ['packages/cli/src/**'],
      exclude: ['**/*.d.ts', 'packages/cli/dist/**', '**/node_modules/**'],
      reporter: ['text', 'json-summary'],
      // Measured 75.68% lines (1466/1937):
      //   npx vitest run --coverage
      //
      // Scoped to packages/cli/src and NOT src/** on purpose. src/** is the mobile
      // app and it is covered by TWO runners — vitest runs ClaudeService.test.ts
      // and chatStore.test.ts, while ChatScreen is only rendered by jest via
      // `src/**/*.jest.{ts,tsx}`, which these globs cannot match. Covering src/**
      // would report ChatScreen.tsx as uncovered, which is a runner artefact rather
      // than a coverage gap. The app's coverage is a separate number and a separate
      // commit; see docs/TERMINAL221B-GATES.md.
      //
      // The floor is 75, a whole number just below 75.68, not 75.68 itself. This box
      // runs Node 24 and CI runs Node 22, and v8 coverage is not guaranteed to be
      // identical across them — a threshold pinned to a measured float would go red
      // for a reason that has nothing to do with the code, which is the permanently
      // red gate this programme exists to prevent. It is still a ratchet: it passes
      // today, and any real drop fails.
      //
      // Lines only. Branch (64.97%) and functions (84.69%) are reported, not gated.
      thresholds: { lines: 75 },
    },
  },
})
