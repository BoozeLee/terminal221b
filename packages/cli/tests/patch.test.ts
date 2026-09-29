import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyApprovedPatch, validatePatchPaths } from '../src/patch.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal221b-patch-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('patch approval and workspace boundaries', () => {
  it('rejects paths that escape the selected workspace', async () => {
    const root = await makeDirectory();
    const patch = [
      'diff --git a/../outside.txt b/../outside.txt',
      '--- a/../outside.txt',
      '+++ b/../outside.txt',
      '@@ -0,0 +1 @@',
      '+not allowed',
      '',
    ].join('\n');

    await expect(validatePatchPaths(root, patch)).rejects.toThrow(
      'disallowed path'
    );
  });

  it('refuses patches that target environment secrets or private keys', async () => {
    const root = await makeDirectory();
    const patch = [
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    await expect(validatePatchPaths(root, patch)).rejects.toThrow(
      'disallowed path'
    );
  });

  it('rejects writes through workspace symlinks', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory();
    await writeFile(join(outside, 'target.ts'), 'old');
    await symlink(outside, join(root, 'linked'));
    const patch = [
      'diff --git a/linked/target.ts b/linked/target.ts',
      '--- a/linked/target.ts',
      '+++ b/linked/target.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');

    await expect(validatePatchPaths(root, patch)).rejects.toThrow(
      'symbolic link'
    );
  });

  it('requires explicit approval before applying an otherwise checked diff', async () => {
    const root = await makeDirectory();
    const patch = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const runGitApply = vi.fn();

    await expect(
      applyApprovedPatch(root, patch, async () => false, runGitApply)
    ).rejects.toThrow('Patch application was not approved');
    expect(runGitApply).toHaveBeenCalledTimes(1);
    expect(runGitApply).toHaveBeenCalledWith(root, patch, true);
  });

  it('applies the checked diff only after explicit approval', async () => {
    const root = await makeDirectory();
    const patch = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const runGitApply = vi.fn();
    const paths = await applyApprovedPatch(root, patch, async () => true, runGitApply);

    expect(paths).toEqual(['src/file.ts']);
    expect(runGitApply.mock.calls.map((call) => call[2])).toEqual([true, false]);
  });
});
