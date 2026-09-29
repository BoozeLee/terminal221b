import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeService } from './ClaudeService';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClaudeService.sendMessage', () => {
  it('sends the configured request and returns its first text block', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'A mocked reply' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
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

  it('rejects missing API keys and empty conversations without a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ClaudeService.sendMessage({
        apiKey: '',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toThrow('API key is required');

    await expect(
      ClaudeService.sendMessage({ apiKey: 'test-key', messages: [] })
    ).rejects.toThrow('At least one message is required');

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
      ClaudeService.sendMessage({
        apiKey: 'invalid-key',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toThrow('Invalid API key');
  });
});
