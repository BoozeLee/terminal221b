/**
 * The one component in this app that had no render coverage.
 *
 * Until SDK 57 there was no runner for it: the 390-test suite is vitest, which
 * has no React Native preset, so `ChatScreen` — 459 lines, the only screen, and
 * the surface a user actually touches — was never mounted in a test. The store
 * and the provider client were covered; the thing that draws them was not.
 *
 * Named `*.jest.tsx` so vitest's globs cannot take it. See jest.config.js.
 *
 * Every test awaits. `@testing-library/react-native` v14 made `render`,
 * `fireEvent.*`, `rerender` and `unmount` return promises, because rendering is
 * now genuinely asynchronous. Calling them synchronously does not fail loudly:
 * you get a Promise back, `screen` is never populated, and the first assertion
 * reports "render function has not been called" — a message about the test, not
 * about the screen. All four tests failed that way the first time. See
 * `@testing-library/react-native/dist/render.d.ts` for the signature.
 *
 * Globals are imported, not ambient, for the same reason the vitest suites
 * import theirs from 'vitest': `@types/jest` declares a global `jest` NAMESPACE,
 * which makes `jest.mock` a type error ("Cannot use namespace 'jest' as a
 * value") and would additionally let a vitest file call `jest.fn()` and
 * typecheck cleanly, then fail at runtime. Two runners, two import styles, no
 * ambient test globals anywhere.
 *
 * The store and the provider client are mocked, deliberately. A render test that
 * talks to AsyncStorage or a live Anthropic endpoint tests the network, not the
 * screen, and it fails for reasons the author did not write. What is asserted here
 * is what the screen says and does in response to state — which is the part that
 * was uncovered.
 */
import React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockConfig = { model: 'claude-sonnet-4-5', apiKey: '' };

jest.mock('../../store/chatStore', () => ({
  useChatStore: jest.fn(() => ({
    sessions: [],
    currentSessionId: null,
    config: mockConfig,
    isLoading: false,
    hasLoadedFromStorage: true,
    storageError: null,
    addMessage: jest.fn(),
    createSession: jest.fn(),
    setLoading: jest.fn(),
    updateConfig: jest.fn(),
  })),
}));

jest.mock('../../services/api/ClaudeService', () => ({
  ClaudeService: jest.fn(),
  ClaudeServiceError: class extends Error {},
  describeClaudeFailure: jest.fn(() => 'failed'),
  isClaudeRetryable: jest.fn(() => false),
  CLAUDE_SERVICE_TIMEOUT_MS: 120_000,
}));

import { ChatScreen } from './ChatScreen';

describe('ChatScreen', () => {
  it('names the product and the model when there is no session yet', async () => {
    await render(<ChatScreen />);

    // The header falls back to the product name, and the subtitle is the model
    // with the provider prefix stripped. Both are easy to break by changing a
    // string and neither was covered before.
    expect(screen.getByText('Terminal 221B')).toBeTruthy();
    expect(screen.getByText('sonnet-4-5')).toBeTruthy();
  });

  it('shows the message composer', async () => {
    await render(<ChatScreen />);
    expect(screen.getByPlaceholderText('Message Claude...')).toBeTruthy();
  });

  it('opens settings and states how the API key is handled on this platform', async () => {
    await render(<ChatScreen />);

    await fireEvent.press(screen.getByText('Settings'));

    // The note is the security-relevant part: it tells the user where their key
    // goes, and it differs by platform. Asserting the text rather than the
    // presence of a modal is the point — a modal that opens saying the wrong
    // thing about key storage is worse than no modal.
    expect(screen.getByText('Anthropic API key')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter your API key')).toBeTruthy();

    // Asserted against the native branch specifically, not /either branch/. A
    // regex matching both would still pass if the two branches were swapped,
    // and a swap is the dangerous version of this regression: a native build
    // telling the user its key is kept in memory when it is written to disk.
    // The guard line below fails first if this ever stops being a native run,
    // so the reason for the failure is legible instead of mysterious.
    expect(Platform.OS).not.toBe('web');
    expect(
      screen.getByText(
        'On this device, the key is stored using the operating system secure-storage API.'
      )
    ).toBeTruthy();
  });

  it('closes settings without saving', async () => {
    await render(<ChatScreen />);

    await fireEvent.press(screen.getByText('Settings'));
    expect(screen.getByText('Anthropic API key')).toBeTruthy();

    await fireEvent.press(screen.getByText('Cancel'));
    // The panel is gone. If this fails the modal is not actually dismissable,
    // which on a real device means the key field stays on screen.
    expect(screen.queryByText('Anthropic API key')).toBeNull();
  });
});
