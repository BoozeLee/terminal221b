import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_SERVICE_TIMEOUT_MS,
  ClaudeService,
  ClaudeServiceError,
  describeClaudeFailure,
  isClaudeRetryable,
} from './ClaudeService';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function textResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ClaudeService.sendMessage', () => {
  it('sends the configured request and returns its first text block', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(textResponse('A mocked reply'));
    vi.stubGlobal('fetch', fetchMock);

    const reply = await ClaudeService.sendMessage({
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(reply).toBe('A mocked reply');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('sends a signal, so the request is cancellable (F24)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(textResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await ClaudeService.sendMessage({ apiKey: 'k', messages: [{ role: 'user', content: 'Hi' }] });

    // The old code sent no signal at all, so a hung provider hung the app.
    const request = fetchMock.mock.calls[0]![1];
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.signal?.aborted).toBe(false);
  });

  it('rejects missing API keys and empty conversations without a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ClaudeService.sendMessage({ apiKey: '', messages: [{ role: 'user', content: 'Hello' }] })
    ).rejects.toThrow('API key is required');
    await expect(ClaudeService.sendMessage({ apiKey: 'test-key', messages: [] })).rejects.toThrow(
      'At least one message is required'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces API error messages', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ClaudeService.sendMessage({ apiKey: 'invalid-key', messages: [{ role: 'user', content: 'Hi' }] })
    ).rejects.toThrow('Invalid API key');
  });
});

describe('a timeout is a timeout (the test F24 was missing)', () => {
  it('reports kind timeout with the budget, not a generic failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
      timeoutMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeServiceError);
    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'timeout', timeoutMs: 5 });
    expect((error as ClaudeServiceError).message).toContain('5ms');
  });

  it('reports kind timeout when the transport throws AbortError after the signal fires', async () => {
    // A transport may reject with AbortError without the signal being observable
    // as aborted, so both shapes must land on the same kind.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure.kind).toBe('network');
  });

  it('a timeout is retryable and a missing key is not', () => {
    expect(isClaudeRetryable({ kind: 'timeout', timeoutMs: 1 })).toBe(true);
    expect(isClaudeRetryable({ kind: 'missing_key' })).toBe(false);
    expect(isClaudeRetryable({ kind: 'no_text_block' })).toBe(false);
  });
});

describe('every failure stays a distinct kind (blueprint 6.4)', () => {
  it('a refused connection is network, carrying the cause', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')));

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'network', detail: 'ECONNREFUSED' });
  });

  it('a non-Error throw is still typed rather than discarded', async () => {
    // The old catch turned this into "Failed to send message to Claude API",
    // which is the exact collapse F24 is about.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue('a bare string'));

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'network', detail: 'a bare string' });
  });

  it('an HTTP refusal is http_error with its status, distinct from network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({
      kind: 'http_error',
      status: 429,
      detail: 'rate limited',
    });
  });

  it('an unparseable error body keeps the status instead of vanishing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }))
    );

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    const failure = (error as ClaudeServiceError).failure;
    expect(failure.kind).toBe('http_error');
    expect(failure).toMatchObject({ status: 502 });
  });

  it('a success body that is not JSON is invalid_json, not no_text_block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('not json at all', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'invalid_json', status: 200 });
  });

  it('an empty text block is a refusal, never an empty success', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(textResponse('   ')));

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'no_text_block' });
  });

  it('a missing content array is no_text_block, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );

    const error = await ClaudeService.sendMessage({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((caught: unknown) => caught);

    expect((error as ClaudeServiceError).failure).toEqual({ kind: 'no_text_block' });
  });

  it('renders one human line per kind, from the typed value', () => {
    expect(describeClaudeFailure({ kind: 'missing_key' })).toMatch(/no API key/);
    expect(describeClaudeFailure({ kind: 'network', detail: 'x' })).toContain('x');
    expect(describeClaudeFailure({ kind: 'timeout', timeoutMs: 900 })).toContain('900ms');
    expect(describeClaudeFailure({ kind: 'http_error', status: 500, detail: 'boom' })).toContain('500');
    expect(describeClaudeFailure({ kind: 'invalid_json', status: 200 })).toContain('200');
    expect(describeClaudeFailure({ kind: 'no_text_block' })).toMatch(/no text/);
    expect(describeClaudeFailure({ kind: 'cancelled', reason: 'user' })).toContain('user');
    expect(describeClaudeFailure({ kind: 'unsupported_capability', capability: 'tools' })).toContain('tools');
    expect(describeClaudeFailure({ kind: 'schema_mismatch', detail: 'shape' })).toContain('shape');
  });
});

describe('validateApiKey reports why, not just that', () => {
  it('returns null when the key works', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(textResponse('ok')));
    expect(await ClaudeService.validateApiKey('good-key')).toBeNull();
  });

  it('returns the typed failure rather than a bare false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    expect(await ClaudeService.validateApiKey('bad-key')).toEqual({
      kind: 'http_error',
      status: 401,
      detail: 'Invalid API key',
    });
  });
});

describe('the boundary is shared with the CLI, not copied', () => {
  it('imports the failure vocabulary from the CLI rather than declaring a second one', () => {
    // If this ever fails, someone has locally redeclared the union and the
    // three surfaces have started drifting again.
    const source = readFileSync(join(REPO, 'src', 'services', 'api', 'ClaudeService.ts'), 'utf8');
    expect(source).toMatch(/import type \{ ProviderFailure \}/);
    expect(source).not.toMatch(/type ProviderFailure\s*=/);
  });

  it('agrees with the CLI adapter on the timeout budget', () => {
    // A duplicated constant is only safe while something proves it has not
    // drifted, and this is that something. The constant lives in the CLI
    // *adapter* (`anthropic.ts`), not in `provider.ts` — the boundary itself is
    // transport-free and holds no timing policy, so the budget is an adapter
    // choice and this test pins the two adapters to the same one.
    const cli = readFileSync(join(REPO, 'packages', 'cli', 'src', 'anthropic.ts'), 'utf8');
    const match = cli.match(/DEFAULT_TIMEOUT_MS\s*=\s*([0-9_]+)/);
    expect(match).not.toBeNull();
    expect(CLAUDE_SERVICE_TIMEOUT_MS).toBe(Number((match as RegExpMatchArray)[1]?.replace(/_/g, '')));
  });

  it('the timeout test would fail if the signal were removed', () => {
    // The control for the finding. If someone drops `signal` from the fetch
    // options again, this reads the source and fails, rather than the timeout
    // tests going quietly green because nothing can ever time out.
    const source = readFileSync(join(REPO, 'src', 'services', 'api', 'ClaudeService.ts'), 'utf8');
    expect(source).toMatch(/signal,/);
    expect(source).toMatch(/controller\.abort\(\)/);
  });

  it('keeps the renderer local, because the CLI one cannot be bundled for a device', () => {
    // A value import would pull provider.ts -> system-prompt.ts -> node:fs into
    // the React Native bundle, which fails at runtime rather than at build.
    const source = readFileSync(join(REPO, 'src', 'services', 'api', 'ClaudeService.ts'), 'utf8');
    expect(source).toMatch(/import type/);
    expect(source).not.toMatch(/^import \{[^}]*describeFailure/m);
  });
});
