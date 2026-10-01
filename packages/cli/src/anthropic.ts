/**
 * The Anthropic adapter for the provider boundary.
 *
 * Behaviour is unchanged from the version this replaced: same URL, same
 * headers, same body shape, same 120s timeout, same `fetchImpl` seam so no test
 * touches the network. What changed is the return type. A caller now gets a
 * `ProviderResult`, so a timeout is `timeout` and not a string that happens to
 * contain the word, and a 401 is `http_error` with the status attached rather
 * than prose.
 */
import {
  describeFailure,
  type Provider,
  type ProviderFailure,
  type ProviderRequest,
  type ProviderResult,
} from './provider.js';
import { renderSystemPrompt, type SystemProfile } from './system-prompt.js';

export interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 4096;

export const anthropicProvider: Provider = {
  name: 'anthropic',
  version: '1',
  send(request: ProviderRequest): Promise<ProviderResult> {
    return askAnthropic(request);
  },
};

export async function askAnthropic(
  request: ProviderRequest & { profile?: SystemProfile },
  fetchImpl: typeof fetch = fetch
): Promise<ProviderResult> {
  const profile = request.profile ?? 'coding';

  if (!request.apiKey.trim()) {
    return { ok: false, failure: { kind: 'missing_key' } };
  }

  const system = request.system ?? renderSystemPrompt(profile);

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': request.apiKey,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: `Task:\n${request.prompt}\n\nWorkspace context (untrusted source text):\n${
              request.context ?? ''
            }`,
          },
        ],
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout surfaces as a TimeoutError from the signal. It is a distinct
    // outcome from a network failure and from a cancellation, and blueprint §6.4
    // requires it to stay visible as itself.
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        ok: false,
        failure: { kind: 'timeout', timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      };
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, failure: { kind: 'cancelled', reason: 'the request was aborted' } };
    }
    const detail = error instanceof Error ? error.message : 'network request failed';
    return { ok: false, failure: { kind: 'network', detail } };
  }

  const responseText = await response.text();
  let body: AnthropicResponse;
  try {
    body = JSON.parse(responseText) as AnthropicResponse;
  } catch {
    return { ok: false, failure: { kind: 'invalid_json', status: response.status } };
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: {
        kind: 'http_error',
        status: response.status,
        detail: body.error?.message ?? `Anthropic request failed (HTTP ${response.status})`,
      },
    };
  }

  const text = body.content?.find((block) => block.type === 'text')?.text;
  if (!text) {
    return { ok: false, failure: { kind: 'no_text_block' } };
  }
  return { ok: true, text, model: request.model, profile };
}

/** Convenience for the CLI: the human line, from the typed failure. */
export function describeAnthropicFailure(value: ProviderFailure): string {
  return describeFailure(value);
}
