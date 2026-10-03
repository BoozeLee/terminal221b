---
name: terminal221b-expo-upgrade
description: Upgrade Terminal221b's Expo/React Native app across SDKs. Use when touching expo, react-native, React, or TypeScript versions, the mobile app's build, or its component tests. Covers the pinned current versions, the traps that break the build mid-upgrade, and the SDK-matched test-runner rule.
---

# Terminal221b Expo upgrade

## Current versions, verified against the registry

| Package | Pinned in `package.json` |
|---|---|
| `expo` | `~54.0.33` |
| `react-native` | `0.81.5` |
| `react` | `19.1.0` |
| `react-dom` | `19.1.0` |
| `typescript` | `~5.9.2` |

`expo` dist-tags at the time of writing: `latest` = 57.0.26, `next` = 58.0.2,
`sdk-54` = 54.0.37, `sdk-55` = 55.0.31, `sdk-56` = 56.0.23, `sdk-57` = 57.0.26.

**Re-read these before planning an upgrade.** They move, and a plan built on last
month's dist-tags is a plan built on a stale number.

## The target, and why it is staged

The goal is SDK 57 with React Native 0.86.3. The route is
**54 → 55 → 56 → 57, one SDK per commit.** A single 54 → 57 jump is not a shortcut,
it is a merge conflict with no bisect point: when it breaks, there is no commit that
separates "the jump" from "the thing the jump broke".

## Traps, verified

1. **`expo@58.0.2` is dist-tagged `next`, not `latest`.** Its template pins
   `react-native 0.88.0-rc.3`. **Never run `npx expo install expo@next`.** This is
   the single most destructive command available in this repository, and it looks
   like the obvious one.
2. **Use ≥ `expo@57.0.17`.** It carries the inherited Hermes fixes for the
   reanimated/worklets memory blowup (`57.0.9`) and for dev startup time
   (`57.0.17`).
3. **React Native moved org.** `react-native`'s `repository.url` is now
   `https://github.com/react/react-native`, not `facebook/react-native`. Any
   `repository` field still pointing at `facebook/` is stale and should be corrected
   in the same commit that bumps the version.
4. **iOS 27 SDK requires the scene-based lifecycle or the app does not launch.** On
   SDK 57 that is opt-in via `expo-build-properties` (`ios.enableSceneSupport`).
   This fails at launch, not at build, so a green build is not evidence the app
   starts.
5. **Pin TypeScript to 6.x, not the npm `latest`.** TS 7 has no programmatic API
   until 7.1 and emits silently invalid `.d.ts` under `nodenext`.

## Component tests: the SDK-matched runner rule

The app has **24 tests across 2 files** — `src/services/api/ClaudeService.test.ts`
(21) and `src/store/chatStore.test.ts` (3) — on vitest, out of 385 in the
repository. The CLI holds the other 361 across 18 files.

`jest-expo` dist-tags: `sdk-54` = 54.0.18, `latest` = 57.0.5. And `jest-expo@latest`
peer-requires `@react-native/jest-preset ^0.86.3` — an SDK 57-era dependency set.

**So `npx expo install jest-expo`, not `npm install jest-expo@latest`.** On SDK 54,
`@latest` pulls a jest preset built for RN 0.86 against RN 0.81 and fails in ways
that look like a config problem rather than a version mismatch. Use
`npx expo install`, which resolves the version matching the installed SDK.

Two further costs to state before proposing it:

- **It introduces a second test runner.** Vitest already runs the app's 24 tests.
  Adding jest-expo means two runners, two config surfaces, and two CI steps. Every
  number in the docs then needs its re-derivation command for both suites.
- **The untested surface is one file.** Of the app's 8 files, the ones with no
  render coverage are `App.tsx`, `index.ts`, `src/types/index.ts`, and
  `src/screens/Chat/ChatScreen.tsx`. Only `ChatScreen.tsx` is a component worth
  rendering. This is a small, well-bounded win — worth doing deliberately, not worth
  restructuring the repo's test story around.

Never use `react-test-renderer`: deprecated, and it has no React 19+ support.

## Per-SDK acceptance

Run all of these after each single-SDK commit, not once at the end:

```sh
npx expo install --check          # must report no version mismatches
npx expo-doctor                   # rc=0
npx tsc --noEmit                  # rc=0
npm test                          # rc=0, same test count as before the upgrade
npm run test:count                # rc=0 — asserts 385 executed, not merely collected
npx expo export --platform web    # rc=0
```

The `test:count` step is the one that catches an SDK bump silently skipping tests.
After an upgrade, re-derive the floor rather than assuming 385 still holds: a
newly-skipped conditional suite is exactly the failure an SDK change causes.

## Rules

1. One SDK per commit. Do not batch.
2. Never install `expo@next`.
3. Use `npx expo install` for anything version-coupled; it resolves against the
   installed SDK.
4. Do not add a gate during the upgrade. Gates land in their own commit.
5. Do not push, open a PR, or publish. The upgrade is a local, reviewable series.
