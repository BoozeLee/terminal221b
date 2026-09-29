import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanLocalWorkspace } from '../src/security.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal221b-security-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('scanLocalWorkspace', () => {
  it('reports high-confidence secret patterns without disclosing their values', async () => {
    const root = await makeDirectory();
    const token = `ghp_${'A'.repeat(36)}`;
    await writeFile(join(root, '.env'), `TOKEN=${token}\n`);

    const result = await scanLocalWorkspace(root);

    expect(result.findings).toEqual([
      expect.objectContaining({
        file: '.env',
        line: 1,
        rule: 'github-token',
        severity: 'high',
      }),
    ]);
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it('skips symlinked files and private key directories', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory();
    await mkdir(join(root, '.ssh'));
    const shellFlag = 'shell' + '=True';
    await writeFile(join(outside, 'source.py'), `subprocess.run(cmd, ${shellFlag})`);
    await symlink(join(outside, 'source.py'), join(root, 'linked.py'));
    await writeFile(join(root, '.ssh', 'authorized_keys'), 'ssh-key-material');

    const result = await scanLocalWorkspace(root);
    expect(result.findings).toEqual([]);
  });

  it('labels source patterns as review heuristics rather than confirmed vulnerabilities', async () => {
    const root = await makeDirectory();
    const origin = 'tx.' + 'origin';
    await writeFile(
      join(root, 'contract.sol'),
      `function owner() public view returns (address) { return ${origin}; }\n`
    );

    const result = await scanLocalWorkspace(root);
    expect(result.findings).toEqual([
      expect.objectContaining({
        rule: 'solidity-tx-origin',
        severity: 'review',
        message: expect.stringContaining('Heuristic'),
      }),
    ]);
  });
});
