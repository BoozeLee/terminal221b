import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverTools } from '../src/tools.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('discoverTools', () => {
  it('detects binaries without executing them', async () => {
    directory = await mkdtemp(join(tmpdir(), 'terminal221b-tools-'));
    const fakeTool = join(directory, 'solana');
    await writeFile(fakeTool, '#!/bin/sh\nexit 91\n', { mode: 0o755 });

    const tools = await discoverTools(directory);
    const solana = tools.find((tool) => tool.name === 'Solana CLI');

    expect(solana?.executable).toBe(fakeTool);
    expect(tools.find((tool) => tool.name === 'Foundry forge')?.executable).toBeNull();
  });
});
