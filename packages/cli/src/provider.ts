/**
 * The provider boundary: one typed shape every model call crosses, on every
 * surface.
 *
 * Why this exists. Before it, there were three independent provider
 * implementations — `anthropic.ts` for the CLI, `ask_anthropic` in the Rust TUI,
 * and `ClaudeService` in the Expo app — each with its own error handling, its
 * own system prompt, and its own idea of what a failure is. They had already
 * drifted: the crypto prohibitions were a system prompt in the TUI and user
 * text in the CLI. A boundary enforced in two places is a boundary that has
 * already failed, so this is one shape, and the surfaces implement it.
 *
 * What it is not. This sends a request and reports a result. It does not
 * execute anything, invoke a tool, touch a filesystem, or act on a
 * `writablePaths` declaration. There is still no executor and no OS isolation
 * behind any of this, which is finding F17 and the reason it stays open.
 */
import type { SystemProfile, SystemPrompt } from './system-prompt.js';

export type { SystemProfile, SystemPrompt } from './system-prompt.js';

export interface ProviderRequest {
  apiKey: string;
  model: string;
  /** Rendered from a `SystemProfile`; never a free-text string at a call site. */
  system: SystemPrompt;
  prompt: string;
  /** Untrusted workspace text. Labeled as input, never as instruction. */
  context?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export type ProviderFailureKind =
  | 'missing_key'
  | 'network'
  | 'timeout'
  | 'http_error'
  | 'invalid_json'
  | 'no_text_block'
  | 'cancelled'
  | 'unsupported_capability'
  | 'schema_mismatch';

/**
 * A discriminated union, not a message string. Blueprint §6.4 requires that
 * timeout, adapter exit, malformed events, unsupported capability, permission
 * denial, cancellation, and a missing schema stay *distinct visible outcomes*,
 * and that none of them is ever converted into an empty successful response.
 * A single `Error` with prose in it cannot satisfy either half of that: the
 * caller has to parse English to tell two failures apart, and a caller that
 * misparses gets a string where a refusal belonged.
 */
export type ProviderFailure =
  | { kind: 'missing_key' }
  | { kind: 'network'; detail: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'http_error'; status: number; detail: string }
  | { kind: 'invalid_json'; status: number }
  | { kind: 'no_text_block' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'unsupported_capability'; capability: string }
  | { kind: 'schema_mismatch'; detail: string };

/** True when a failure means "the request may be retried unchanged". */
export function isRetryable(failure: ProviderFailure): boolean {
  return failure.kind === 'network' || failure.kind === 'timeout' || failure.kind === 'http_error';
}

export type ProviderResult =
  | { ok: true; text: string; model: string; profile: SystemProfile }
  | { ok: false; failure: ProviderFailure };

export interface Provider {
  readonly name: string;
  readonly version: string;
  send(request: ProviderRequest): Promise<ProviderResult>;
}

/**
 * One line for a human, from the typed failure rather than beside it. The
 * union stays the source of truth; this is a rendering, not a replacement, and
 * it never collapses two kinds into one message.
 */
export function describeFailure(failure: ProviderFailure): string {
  switch (failure.kind) {
    case 'missing_key':
      return 'ANTHROPIC_API_KEY is required';
    case 'network':
      return `Anthropic request failed: ${failure.detail}`;
    case 'timeout':
      return `Anthropic request timed out after ${failure.timeoutMs}ms`;
    case 'http_error':
      return failure.detail;
    case 'invalid_json':
      return `Anthropic returned invalid JSON (HTTP ${failure.status})`;
    case 'no_text_block':
      return 'Anthropic response did not contain a text block';
    case 'cancelled':
      return `request cancelled: ${failure.reason}`;
    case 'unsupported_capability':
      return `this provider does not support ${failure.capability}`;
    case 'schema_mismatch':
      return `response did not match the expected shape: ${failure.detail}`;
  }
}

/** Exit code per failure kind, so a script can branch without reading prose. */
export function exitCodeFor(failure: ProviderFailure): number {
  switch (failure.kind) {
    case 'missing_key':
      return 2;
    case 'cancelled':
      return 130;
    case 'http_error':
      return failure.status >= 500 ? 5 : 4;
    default:
      return 1;
  }
}
