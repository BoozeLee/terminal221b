/**
 * The component-test runner. This is a SECOND runner, deliberately.
 *
 * The 390-test suite is vitest and stays that way — it covers the CLI, the store
 * and the provider client, none of which need a React Native renderer. What vitest
 * cannot do is mount a React Native component, because there is no RN preset for
 * it and pretending otherwise produces failures that look like application bugs.
 * `jest-expo` is the runner Expo ships for exactly that, and it only exists for
 * SDK 57, which is why this arrives after the upgrade rather than before it.
 *
 * The two suites are kept apart by filename, not by hope:
 *
 *   vitest.config.ts  include  src/**\/*.{test,spec}.{ts,tsx}
 *   jest.config.js    testMatch src/**\/*.jest.{ts,tsx}
 *
 * A component test is therefore named `*.jest.tsx` and vitest cannot pick it up
 * even by accident. If you add one as `*.test.tsx` expecting jest to run it,
 * vitest will take it and fail for reasons that have nothing to do with your test.
 *
 * The executed-count floor in scripts/assert-test-count.sh counts the vitest suite
 * only. This suite is a separate gate with its own exit code, and neither number
 * is evidence about the other.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.jest.{ts,tsx}'],
  // The app's own suites are vitest's. Excluding them here is what stops jest from
  // trying to run `ClaudeService.test.ts` and `chatStore.test.ts` under a second
  // runner, which would double-count them and make two numbers for one suite.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/packages/'],
  // Fail on a console.error. A React render test that logs an act() warning or an
  // unhandled error has found something, and printing it into a green run is the
  // same failure mode as a gate that cannot fail.
  errorOnDeprecated: true,
};
