import { describe, expect, it } from 'vitest';
import { buildCryptoPrompt } from '../src/prompt.js';

describe('buildCryptoPrompt', () => {
  it('sets crypto engineering context and preserves the user request', () => {
    const prompt = buildCryptoPrompt('Suggest an NFT ticketing protocol architecture.');

    expect(prompt).toContain('crypto engineering and research assistant');
    expect(prompt).toContain('NFT design ideas');
    expect(prompt).toContain('Suggest an NFT ticketing protocol architecture.');
  });

  it('disallows investment actions, key handling, and unauthorized target testing', () => {
    const prompt = buildCryptoPrompt('Review this repository.');

    expect(prompt).toContain('Do not give personalized investment recommendations');
    expect(prompt).toContain('handle wallet secrets');
    expect(prompt).toContain('no remote-target testing capability');
  });
});
