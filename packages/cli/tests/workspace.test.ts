import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectWorkspaceContext } from '../src/workspace.js';

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal221b-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('collectWorkspaceContext', () => {
  it('reads sorted source files while excluding secrets and generated directories', async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'z.ts'), 'export const z = 1;');
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;');
    await writeFile(join(root, '.env'), 'SECRET=not-context');
    await writeFile(join(root, 'node_modules', 'package.js'), 'should be ignored');

    const context = await collectWorkspaceContext(root);

    expect(context.files.map(({ path }) => path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(context.files.map(({ content }) => content).join(' ')).not.toContain('SECRET');
    expect(context.totalBytes).toBe(Buffer.byteLength('export const a = 1;export const z = 1;'));
  });

  it('does not follow symlinks out of the selected workspace', async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, 'secret.ts'), 'export const key = "outside";');
    await symlink(outside, join(root, 'linked'));

    const context = await collectWorkspaceContext(root);

    expect(context.files).toEqual([]);
  });

  it('rejects a file rather than treating it as a workspace', async () => {
    const root = await makeWorkspace();
    const file = join(root, 'readme.md');
    await writeFile(file, 'text');

    await expect(collectWorkspaceContext(file)).rejects.toThrow(
      'Workspace path must be a directory'
    );
  });
});
