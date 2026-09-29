import { afterEach, describe, expect, it, vi } from 'vitest';
import { askAnthropic } from '../src/anthropic.js';

afterEach(() => vi.unstubAllGlobals());

describe('askAnthropic', () => {
  it('sends bounded prompt context and returns text from the response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'A mocked answer' }] }),
        { status: 200 }
      )
    );

    const result = await askAnthropic(
      {
        apiKey: 'test-api-key',
        model: 'test-model',
        prompt: 'Explain this code',
        context: 'const value = 1;',
      },
      fetchMock
    );

    expect(result).toBe('A mocked answer');
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

  it('rejects a missing key without making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      askAnthropic(
        { apiKey: ' ', model: 'test', prompt: 'p', context: '' },
        fetchMock
      )
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces provider errors without masking them', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Request denied' } }), {
        status: 401,
      })
    );
    await expect(
      askAnthropic(
        { apiKey: 'bad-key', model: 'test', prompt: 'p', context: '' },
        fetchMock
      )
    ).rejects.toThrow('Request denied');
  });
});
