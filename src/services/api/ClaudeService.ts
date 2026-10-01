// Claude API Service - Pure fetch implementation for web/mobile compatibility
//
// This is the third surface on the provider boundary, and it was the last one
// left off (F24). Two things were wrong and both are now typed rather than
// stringly:
//
// 1. The request carried **no `signal` at all**, so a hung provider could hang
//    the app until the platform gave up, with nothing to report.
// 2. The `catch` collapsed anything that was not an `Error` into the single
//    string `Failed to send message to Claude API`, so a timeout, a cancelled
//    request, a malformed body, and a refused connection all looked identical.
//    Blueprint §6.4 requires those to stay *distinct visible outcomes* and
//    forbids converting any of them into an empty successful response.
//
// The failure union below is imported as a **type only**. That is deliberate
// and it is the reason this surface shares one vocabulary with the CLI and the
// TUI rather than a third copy: a type import is erased at compile time, so
// nothing from `packages/cli` reaches the React Native bundle. The renderer is
// duplicated instead, because the CLI's `describeFailure` reaches a JSON file
// through `node:fs` and cannot be bundled for a device. See F25.

import { ApiResponse, ApiError, MessageContent } from '../../types';
import type { ProviderFailure } from '../../../packages/cli/src/provider.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Matches `DEFAULT_TIMEOUT_MS` in `packages/cli/src/provider.ts`. There is no
 * way to import that constant here for the reason in the header comment, so it
 * is written down in both places and `claudeBoundary.test.ts` asserts the two
 * files still agree, which is the only thing that makes a duplicated number
 * safe to carry.
 */
export const CLAUDE_SERVICE_TIMEOUT_MS = 120_000;

export interface SendMessageParams {
  apiKey: string;
  messages: MessageContent[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Override for tests and for a caller that wants a different budget. */
  timeoutMs?: number;
}

/**
 * An `Error` so existing `catch` blocks and `Alert.alert(error.message)` keep
 * working, carrying the typed failure so a caller that cares can branch on the
 * kind instead of parsing English. Throwing a bare object would have broken the
 * call site for no gain.
 */
export class ClaudeServiceError extends Error {
  readonly failure: ProviderFailure;

  constructor(failure: ProviderFailure, message: string) {
    super(message);
    this.name = 'ClaudeServiceError';
    this.failure = failure;
  }
}

/**
 * One human line, rendered from the typed value. This mirrors
 * `describeFailure` in `packages/cli/src/provider.ts` for the reason in the
 * header comment; the failure *vocabulary* is shared by import, only the
 * rendering is not.
 */
export function describeClaudeFailure(failure: ProviderFailure): string {
  switch (failure.kind) {
    case 'missing_key':
      return 'no API key is set';
    case 'network':
      return `could not reach the Claude API: ${failure.detail}`;
    case 'timeout':
      return `the Claude API did not answer within ${failure.timeoutMs}ms`;
    case 'http_error':
      return `the Claude API returned HTTP ${failure.status}: ${failure.detail}`;
    case 'invalid_json':
      return `the Claude API returned a body that is not JSON (HTTP ${failure.status})`;
    case 'no_text_block':
      return 'the Claude API response contained no text';
    case 'cancelled':
      return `the request was cancelled: ${failure.reason}`;
    case 'unsupported_capability':
      return `the provider does not support ${failure.capability}`;
    case 'schema_mismatch':
      return `the provider response did not match the expected shape: ${failure.detail}`;
  }
}

/** True when the request may be retried unchanged. Mirrors `isRetryable`. */
export function isClaudeRetryable(failure: ProviderFailure): boolean {
  return failure.kind === 'network' || failure.kind === 'timeout' || failure.kind === 'http_error';
}

/**
 * `AbortSignal.timeout` exists in Node and in modern browsers, but not in every
 * React Native runtime this app may ship to, so the signal is built by hand. A
 * request that cannot be cancelled is the thing F24 is about, so the fallback is
 * not optional.
 */
function timeoutSignal(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export class ClaudeService {
  /**
   * Send a message to Claude API.
   *
   * Returns text, or throws a `ClaudeServiceError` carrying a typed
   * `ProviderFailure`. There is no path that returns an empty string, and no
   * path that collapses two different failures into one.
   */
  static async sendMessage(params: SendMessageParams): Promise<string> {
    const {
      apiKey,
      messages,
      model = 'claude-sonnet-4-5-20250929',
      maxTokens = 4096,
      temperature = 1.0,
      systemPrompt,
      timeoutMs = CLAUDE_SERVICE_TIMEOUT_MS,
    } = params;

    if (!apiKey) {
      throw fail({ kind: 'missing_key' }, 'API key is required');
    }

    if (messages.length === 0) {
      throw fail(
        { kind: 'schema_mismatch', detail: 'a request needs at least one message' },
        'At least one message is required'
      );
    }

    const { signal, done } = timeoutSignal(timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            ...(systemPrompt && { system: systemPrompt }),
            messages: messages.map((msg) => ({
              role: msg.role,
              content: msg.content,
            })),
          }),
          signal,
        });
      } catch (error) {
        // A non-Error throw is still typed rather than discarded. The old code
        // replaced it with a fixed string, which is what made two different
        // failures indistinguishable.
        const detail = error instanceof Error ? error.message : String(error);
        if (signal.aborted) {
          throw fail({ kind: 'timeout', timeoutMs });
        }
        throw fail({ kind: 'network', detail });
      }

      if (!response.ok) {
        const detail = await errorMessageFrom(response);
        throw fail({ kind: 'http_error', status: response.status, detail });
      }

      let data: ApiResponse;
      try {
        data = (await response.json()) as ApiResponse;
      } catch {
        throw fail({ kind: 'invalid_json', status: response.status });
      }

      const textContent = data.content?.find((c) => c.type === 'text');
      if (!textContent || textContent.text.trim() === '') {
        throw fail({ kind: 'no_text_block' }, 'No text content in API response');
      }

      return textContent.text;
    } catch (error) {
      if (error instanceof ClaudeServiceError) throw error;
      // Nothing else can reach here today, and if something new can, it is
      // named rather than swallowed. This arm exists to be visible.
      throw fail({ kind: 'network', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      done();
    }
  }

  /**
   * Validate an API key.
   *
   * Returns the typed failure rather than a bare `false`, because a boolean is
   * the same collapsing this slice exists to remove: a wrong key and a network
   * outage are different problems with different fixes, and `false` tells the
   * operator neither. `null` means the key worked.
   */
  static async validateApiKey(apiKey: string): Promise<ProviderFailure | null> {
    try {
      await this.sendMessage({
        apiKey,
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10,
      });
      return null;
    } catch (error) {
      if (error instanceof ClaudeServiceError) return error.failure;
      throw error;
    }
  }

  /**
   * Get list of available models
   */
  static getAvailableModels(): Array<{ id: string; name: string; description: string }> {
    return [
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        description: 'Most capable model, best for complex tasks',
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Balanced performance and speed (recommended)',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'Fastest model for quick responses',
      },
    ];
  }
}

function fail(failure: ProviderFailure, message?: string): ClaudeServiceError {
  return new ClaudeServiceError(failure, message ?? describeClaudeFailure(failure));
}

/**
 * An error body is JSON, but a proxy in front of the provider may return HTML,
 * so parsing it is allowed to fail without replacing the status that mattered.
 */
async function errorMessageFrom(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as ApiError;
    return data.error?.message || `API Error: ${response.statusText || response.status}`;
  } catch {
    return `API Error: ${response.statusText || response.status}`;
  }
}
