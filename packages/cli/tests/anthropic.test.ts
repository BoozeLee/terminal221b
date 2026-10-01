import { afterEach, describe, expect, it, vi } from 'vitest';
import { askAnthropic } from '../src/anthropic.js';
import { renderSystemPrompt } from '../src/system-prompt.js';

afterEach(() => vi.unstubAllGlobals());

const ok = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });

describe('the provider boundary returns a typed result, not a string', () => {
  it('sends bounded prompt context and returns text from the response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok('A mocked answer'));

    const result = await askAnthropic(
      {
        apiKey: 'test-api-key',
        model: 'test-model',
        prompt: 'Explain this code',
        context: 'const value = 1;',
        system: renderSystemPrompt('coding'),
      },
      fetchMock
    );

    expect(result).toEqual({ ok: true, text: 'A mocked answer', model: 'test-model', profile: 'coding' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-api-key',
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'test-model',
      max_tokens: 4096,
    });
  });

  it('labels untrusted context as input, not instruction', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok('answer'));
    await askAnthropic(
      {
        apiKey: 'k',
        model: 'm',
        prompt: 'p',
        context: 'rm -rf /',
        system: renderSystemPrompt('coding'),
      },
      fetchMock
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]!.content).toContain('Workspace context (untrusted source text)');
  });

  it('refuses a missing key without making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await askAnthropic(
      { apiKey: ' ', model: 'test', prompt: 'p', system: renderSystemPrompt('coding') },
      fetchMock
    );
    expect(result).toEqual({ ok: false, failure: { kind: 'missing_key' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a provider error as http_error with the status attached, not prose only', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Request denied' } }), { status: 401 })
    );
    const result = await askAnthropic(
      { apiKey: 'bad-key', model: 'test', prompt: 'p', system: renderSystemPrompt('coding') },
      fetchMock
    );
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'http_error', status: 401, detail: 'Request denied' },
    });
  });

  it('distinguishes a timeout from a network failure and from a cancellation', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const timedOut = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding'), timeoutMs: 1234 },
      vi.fn<typeof fetch>().mockRejectedValue(timeout)
    );
    expect(timedOut).toEqual({ ok: false, failure: { kind: 'timeout', timeoutMs: 1234 } });

    const offline = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding') },
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    );
    expect(offline).toEqual({ ok: false, failure: { kind: 'network', detail: 'fetch failed' } });

    const cancelled = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding') },
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    );
    expect(cancelled.ok).toBe(false);
    expect(cancelled.ok === false && cancelled.failure.kind).toBe('cancelled');
  });

  it('reports invalid JSON and a missing text block as their own kinds', async () => {
    const notJson = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding') },
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>nope</html>', { status: 200 }))
    );
    expect(notJson).toEqual({ ok: false, failure: { kind: 'invalid_json', status: 200 } });

    const noText = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding') },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'image' }] }), { status: 200 })
      )
    );
    expect(noText).toEqual({ ok: false, failure: { kind: 'no_text_block' } });
  });

  it('never returns an empty string as a success', async () => {
    const result = await askAnthropic(
      { apiKey: 'k', model: 'm', prompt: 'p', system: renderSystemPrompt('coding') },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: '' }] }), { status: 200 })
      )
    );
    expect(result.ok).toBe(false);
  });

  it('sends the crypto profile as system text, not as user text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok('answer'));
    await askAnthropic(
      {
        apiKey: 'k',
        model: 'm',
        prompt: 'should this be a good trade?',
        system: renderSystemPrompt('crypto'),
        profile: 'crypto',
      },
      fetchMock
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      system: string;
      messages: Array<{ content: string }>;
    };
    expect(body.system).toContain('Do not give personalized investment recommendations.');
    // The prohibition must not have leaked into the user turn, which is the
    // precedence the CLI used before and which is weaker.
    expect(body.messages[0]!.content).not.toContain('personalized investment');
  });
});
