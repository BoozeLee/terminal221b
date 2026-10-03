---
name: terminal221b-expo-upgrade
description: Upgrade Terminal221b's Expo/React Native app across SDKs. Use when touching expo, react-native, React, or TypeScript versions, the mobile app's build, or its component tests. Covers the pinned current versions, the traps that break the build mid-upgrade, the SDK-matched test-runner rule, and the RNTL v14 async-render trap.
---

# Terminal221b Expo upgrade

> **Status: the 54 → 57 upgrade is DONE** (`0474a68` 55, `2e0630f` 56, `c19b307` 57).
> The version table below is what is pinned *now*, verified against `package.json`
> and the registry at the time of writing. Everything under "Traps" is a thing that
> actually broke during that run, not a thing predicted in advance.

## Current versions, verified against the registry

| Package | Pinned in `package.json` |
|---|---|
| `expo` | `~57.0.26` |
| `react-native` | `0.86.3` |
| `react` | `19.2.3` |
| `react-dom` | `19.2.3` |
| `expo-secure-store` | `~57.0.4` |
| `expo-status-bar` | `~57.0.1` |
| `expo-splash-screen` | `~57.0.9` |
| `react-native-screens` | `~4.26.0` |
| `typescript` | `~6.0.3` |

`expo` dist-tags: `latest` = `sdk-57` = 57.0.26, `next` = 58.0.2, `sdk-56` = 56.0.23,
`sdk-55` = 55.0.31, `sdk-54` = 54.0.37.

`jest-expo` dist-tags: `latest` = 57.0.5, `next` = 58.0.6, `sdk-56` = 56.0.5,
`sdk-55` = 55.0.22, `sdk-54` = 54.0.18.

**Re-read these before planning an upgrade.** They move, and a plan built on last
month's dist-tags is a plan built on a stale number.

## The route, and why it was staged

54 → 55 → 56 → 57, one SDK per commit, which is what actually happened. A single
54 → 57 jump is not a shortcut, it is a merge conflict with no bisect point: when
it breaks, there is no commit that separates "the jump" from "the thing the jump
broke". The 56 commit exists precisely so that the Hermes regression has a commit
to be found in.

## Traps, verified

1. **`expo@58.0.2` is dist-tagged `next`, not `latest`.** Its template pins
   `react-native 0.88.0-rc.3`. **Never run `npx expo install expo@next`.** This is
   the single most destructive command available in this repository, and it looks
   like the obvious one.
2. **SDK 56 is a waypoint, never a shipping target.** It carries the Hermes V1
   memory regression. It was committed here on purpose, labelled as such, and
   discharged by 57. If you land on 56, land on 57 before shipping anything.
3. **`expo install expo@X` moves `expo` and nothing else.** Every coupled package
   — react, react-native, react-dom, the expo-* modules, typescript — is left
   behind and `expo install --check` then reports the mismatch. Always
   `--fix`, which is what moved TypeScript to 6.0.3 on its own.
4. **Pin TypeScript to 6.x, not the npm `latest`.** TS 7 has no programmatic API
   until 7.1 and emits silently invalid `.d.ts` under `nodenext`. `--fix` lands on
   6.0.3, which is the required 6.x — leave it there rather than "upgrading" to
   7.0.2 by hand.
5. **SDK 56 removed props that look load-bearing and are not.**
   `StatusBar` no longer takes `backgroundColor` (`App.tsx:23`, which now passes
   only `style`, with the reason recorded in the comment above it), and `app.json`
   no longer accepts `newArchEnabled` or `edgeToEdgeEnabled` — both are out of the
   schema, so leaving them is a validation error rather than an ignored key.
   `splash` had to move *into* the `expo-splash-screen` plugin block in `app.json`.
6. **iOS 27 SDK requires the scene-based lifecycle or the app does not launch.** On
   SDK 57 that is opt-in via `expo-build-properties` (`ios.enableSceneSupport`).
   This fails at launch, not at build, so a green build is not evidence the app
   starts.
7. **React Native moved org.** `react-native`'s `repository.url` is now
   `https://github.com/react/react-native`, not `facebook/react-native`.

## Component tests: the SDK-matched runner rule

`jest-expo` is the runner Expo ships for mounting React Native components, and it
exists only for SDK 57+. Before the upgrade, `ChatScreen` — 459 lines, the only
screen, the surface a user actually touches — had **never been mounted in a test**.
The store and the provider client were covered; the thing that draws them was not.

**So `npx expo install jest-expo`, not `npm install jest-expo@latest`.** On SDK 54,
`@latest` pulls a jest preset built for RN 0.86 against RN 0.81 and fails in ways
that look like a config problem rather than a version mismatch. This was not
hypothetical: it was the reason the component work was deferred until after 57.

### Two runners, separated by filename

| | globs | count floor |
|---|---|---|
| vitest | `src/**/*.{test,spec}.{ts,tsx}` | 390 / 384 — see `docs/TERMINAL221B-GATES.md` §3 |
| jest | `src/**/*.jest.{ts,tsx}` | 4, zero skips — §3c |

A component test is named `*.jest.tsx` so vitest cannot match it. The vitest floor
counts the vitest suite only; neither number is evidence about the other. Verify
the separation rather than assuming it: `npx vitest list | grep ChatScreen` must
print nothing.

### RNTL v14 made rendering async — the trap that costs an afternoon

`@testing-library/react-native` v14 changed `render`, `fireEvent.*`, `rerender` and
`unmount` to return **promises**. The synchronous form does not fail loudly. You
get a Promise back, `screen` is never populated, and every test dies on the same
misleading message:

```
Unable to find an element with text: Terminal 221B
> render function has not been called
```

That message points at the test harness when the real cause is one missing
`await`. Every test must `await render(...)` and `await fireEvent.press(...)`.
Signature: `node_modules/@testing-library/react-native/dist/render.d.ts`, where
`RenderResult = Awaited<ReturnType<typeof render>>`.

### Do not install `@types/jest`

It declares a global `jest` **namespace**, which makes `jest.mock` a type error
(`TS2708: Cannot use namespace 'jest' as a value`) and, worse, would let a vitest
file call `jest.fn()`, typecheck cleanly, and then fail at runtime. The vitest
suites already import their globals from `vitest` for exactly this reason. So the
component suite imports from `@jest/globals` and the project keeps **no ambient
test globals at all**. `jest` and `@jest/globals` must then be declared as direct
devDependencies, because the script and the test both reference them directly
rather than reaching through `jest-expo`.

### `test-renderer` is a PEER dependency, not a dependency

RNTL 14 peer-depends on `test-renderer ^1.0.0`. Peer means nothing installs it for
you. Declare it explicitly. (This is not `react-test-renderer`, which is
deprecated and has no React 19+ support — do not substitute it.)

## Per-SDK acceptance

Run all of these after each single-SDK commit, not once at the end:

```sh
npx expo install --check          # must report no version mismatches
npx expo-doctor                   # rc=0 (21/21 at the time of writing)
npx tsc --noEmit                  # rc=0
npm test                          # rc=0, same test count as before the upgrade
npm run test:count                # rc=0 — asserts 390 executed, not merely collected
npx expo export --platform web    # rc=0
```

`npm run test:count` is the step that catches an SDK bump silently skipping tests.
After an upgrade, re-derive the floor rather than assuming 390 still holds: a
newly-skipped conditional suite is exactly the failure an SDK change causes.

Once the component suite exists, its two commands belong here too:
`npm run test:components` and `npm run test:count:components`.

## Rules

1. One SDK per commit. Do not batch.
2. Never install `expo@next`.
3. Use `npx expo install` for anything version-coupled; it resolves against the
   installed SDK. Use `--fix` to move the coupled packages, not just `expo`.
4. Do not add a gate during the upgrade. Gates land in their own commit. (This
   was followed: the component count floor is `388a8cc`, after the upgrade, not
   inside it.)
5. Do not push, open a PR, or publish. The upgrade is a local, reviewable series.
