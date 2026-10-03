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
  },
})
