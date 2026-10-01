import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTaskContract } from '../src/case.js';
import {
  assertDeclarablePath,
  assertSafePath,
  isDisallowedPathString,
  isSensitivePath,
  withinRoot,
} from '../src/path-guard.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal221b-guard-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    taskId: 'task-1',
    caseId: 'case-1',
    role: 'analyst',
    goal: 'confirm one fact',
    readRefs: ['ev-1'],
    writablePaths: [],
    capability: 'analyze',
    acceptanceChecks: ['ev-1 recorded'],
    provenanceRequired: true,
    outputSchemaVersion: 1,
    ...overrides,
  };
}

describe('withinRoot', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(withinRoot('/w', '/w')).toBe(true);
    expect(withinRoot('/w', '/w/src/file.ts')).toBe(true);
  });

  it('rejects a sibling directory that shares a name prefix', () => {
    expect(withinRoot('/w', '/workspace/file.ts')).toBe(false);
    expect(withinRoot('/w', '/w/../elsewhere')).toBe(false);
  });
});

describe('isSensitivePath', () => {
  it('refuses environment files, credential directories, and key material', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('config/.env.production')).toBe(true);
    expect(isSensitivePath('.ssh/config')).toBe(true);
    expect(isSensitivePath('deploy/secrets/values.yml')).toBe(true);
    expect(isSensitivePath('deploy/credentials')).toBe(true);
    expect(isSensitivePath('certs/server.pem')).toBe(true);
    expect(isSensitivePath('certs/server.key')).toBe(true);
    expect(isSensitivePath('certs/bundle.p12')).toBe(true);
    expect(isSensitivePath('certs/bundle.pfx')).toBe(true);
  });

  it('leaves ordinary source paths alone', () => {
    expect(isSensitivePath('src/file.ts')).toBe(false);
    expect(isSensitivePath('src/environment.ts')).toBe(false);
    expect(isSensitivePath('patches/cache-header.diff')).toBe(false);
  });
});

describe('isDisallowedPathString', () => {
  it('covers every lexical rule the executor enforces', () => {
    for (const path of [
      '',
      'src/"quoted".ts',
      'src\\windows.ts',
      '.env.local',
      '/etc/passwd',
      '../outside.txt',
      'src/../../outside.txt',
      '.git/config',
      'src/.git/hooks/pre-commit',
    ]) {
      expect(isDisallowedPathString(path), path).toBe(true);
    }
  });

  it('accepts ordinary relative workspace paths', () => {
    for (const path of ['patches/cache-header.diff', 'src/file.ts', 'docs/ROADMAP.md', 'a/b/c/d.txt']) {
      expect(isDisallowedPathString(path), path).toBe(false);
    }
  });
});

describe('assertDeclarablePath', () => {
  it('refuses a declared path that walks out of the workspace', () => {
    expect(() => assertDeclarablePath('../../etc/passwd', 'writablePaths')).toThrow(
      'writablePaths declares a disallowed path: ../../etc/passwd'
    );
  });

  it('names the offending path in the refusal', () => {
    expect(() => assertDeclarablePath('.env', 'writablePaths')).toThrow(
      'writablePaths declares a disallowed path: .env'
    );
  });

  it('accepts a path that stays inside the workspace', () => {
    expect(() => assertDeclarablePath('patches/cache-header.diff', 'writablePaths')).not.toThrow();
  });
});

describe('assertSafePath', () => {
  it('keeps the executor message byte-identical for a lexical refusal', async () => {
    const root = await makeDirectory();
    await expect(assertSafePath(root, '../../etc/passwd')).rejects.toThrow(
      'Patch contains a disallowed path: ../../etc/passwd'
    );
  });

  it('still walks the filesystem, so a symlinked parent is refused here', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory();
    await mkdir(join(root, 'real'));
    await symlink(outside, join(root, 'linked'));
    await expect(assertSafePath(root, 'linked/file.ts')).rejects.toThrow(
      'Patch path traverses a symbolic link: linked/file.ts'
    );
  });

  it('refuses a parent that exists but is not a directory', async () => {
    const root = await makeDirectory();
    await writeFile(join(root, 'file.ts'), 'x');
    await expect(assertSafePath(root, 'file.ts/child.ts')).rejects.toThrow(
      'Patch path parent is not a directory: file.ts/child.ts'
    );
  });

  it('accepts a nonexistent leaf beneath an existing directory', async () => {
    const root = await makeDirectory();
    await expect(assertSafePath(root, 'src/new-file.ts')).resolves.toBeUndefined();
  });
});

describe('parseTaskContract writable path guard', () => {
  it('fails to parse a contract that declares a traversal', () => {
    expect(() =>
      parseTaskContract(
        task({ writablePaths: ['../../etc/passwd'], capability: 'modify' })
      )
    ).toThrow('writablePaths declares a disallowed path: ../../etc/passwd');
  });

  it('fails to parse a contract that declares an absolute path', () => {
    expect(() =>
      parseTaskContract(task({ writablePaths: ['/etc/passwd'], capability: 'modify' }))
    ).toThrow('writablePaths declares a disallowed path: /etc/passwd');
  });

  it('fails to parse a contract that declares a key file', () => {
    expect(() =>
      parseTaskContract(task({ writablePaths: ['deploy/server.key'], capability: 'modify' }))
    ).toThrow('writablePaths declares a disallowed path: deploy/server.key');
  });

  it('fails to parse a contract that reaches into .git', () => {
    expect(() =>
      parseTaskContract(task({ writablePaths: ['.git/hooks/pre-commit'], capability: 'modify' }))
    ).toThrow('writablePaths declares a disallowed path: .git/hooks/pre-commit');
  });

  it('still parses a contract whose declared path stays inside the workspace', () => {
    const parsed = parseTaskContract(
      task({ writablePaths: ['patches/cache-header.diff'], capability: 'modify' })
    );
    expect(parsed.writablePaths).toEqual(['patches/cache-header.diff']);
  });

  it('checks every declared path, not only the first', () => {
    expect(() =>
      parseTaskContract(
        task({ writablePaths: ['patches/ok.diff', '.env'], capability: 'modify' })
      )
    ).toThrow('writablePaths declares a disallowed path: .env');
  });

  it('does not weaken the capability check that runs first', () => {
    expect(() => parseTaskContract(task({ writablePaths: ['../../etc/passwd'] }))).toThrow(
      'writablePaths require the modify or submit_publish capability, not analyze'
    );
  });
});
