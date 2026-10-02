import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseTaskContract, type ApprovalRecord } from '../src/case.js';
import {
  TASK_DIFF_EFFECT,
  applyTaskDiff,
  bwrapSandbox,
  bindMounts,
  bindTargetFor,
  createTaskWorktree,
  materializeReadSet,
  pathsOutsideWritable,
  removeTaskWorktree,
  resolveSandbox,
  resolveWritablePaths,
  runTask,
  sandboxAvailable,
  type Sandbox,
  type SandboxRequest,
} from '../src/executor.js';
import { initStore, sha256, signRecord, trustKey } from '../src/store.js';

/**
 * Every negative control here proves a refusal with the real filesystem or a real
 * signature in the way, never with a mock that agrees to refuse. The bubblewrap
 * tests are skipped when it is absent, because a sandbox that does not exist
 * cannot demonstrate isolation — and a test that passes because the thing under
 * test was silently skipped is the exact failure mode this project keeps catching.
 */
const HAS_BWRAP = sandboxAvailable();
const NOW = '2026-10-02T00:00:00Z';
const KEY_ID = 'operator-key';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const STRANGER = generateKeyPairSync('ed25519');

const PATCH =
  'diff --git a/src/app.txt b/src/app.txt\n' +
  '--- a/src/app.txt\n' +
  '+++ b/src/app.txt\n' +
  '@@ -1 +1 @@\n' +
  '-original\n' +
  '+changed\n';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `t221b-${label}-`));
}

/** A committed repository with one tracked source file the tasks can edit. */
function seedRepo(): string {
  const root = scratch('repo');
  git(['init', '--initial-branch=main'], root);
  git(['config', 'user.email', 'executor@example.invalid'], root);
  git(['config', 'user.name', 'Executor Test'], root);
  writeFileSync(join(root, 'README.md'), '# seed\n', 'utf8');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.txt'), 'original\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'seed'], root);
  return root;
}

const contractJson = (over: Record<string, unknown> = {}) => ({
  version: 1,
  taskId: 'task-1',
  caseId: 'case-1',
  role: 'engineer',
  goal: 'change src/app.txt',
  readRefs: [],
  writablePaths: ['src/app.txt'],
  capability: 'modify',
  acceptanceChecks: [],
  provenanceRequired: true,
  outputSchemaVersion: 1,
  ...over,
});

/** A sandbox that records requests, for tests about the flow rather than the kernel. */
function recordingSandbox(status = 0): { sandbox: Sandbox; requests: SandboxRequest[] } {
  const requests: SandboxRequest[] = [];
  return {
    requests,
    sandbox: (request) => {
      requests.push(request);
      return { status, stdout: '', stderr: '' };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The sandbox enforces the write set rather than describing it                */
/* -------------------------------------------------------------------------- */

describe('the sandbox is the enforcement, not a description of one', () => {
  it.skipIf(!HAS_BWRAP)('refuses a write outside the bind with a real EROFS', () => {
    const root = scratch('ro');
    const writable = join(root, 'rw');
    const sibling = join(root, 'outside');
    mkdirSync(writable);
    mkdirSync(sibling);

    // Positive control first: the bind really is writable, or a refusal below
    // would prove nothing.
    const inside = bwrapSandbox({
      command: ['/bin/sh', '-c', 'echo ok > ./allowed.txt'],
      cwd: writable,
      writable: [{ directory: writable }],
      network: false,
    });
    expect(inside.status).toBe(0);
    expect(readFileSync(join(writable, 'allowed.txt'), 'utf8').trim()).toBe('ok');

    const outside = bwrapSandbox({
      command: ['/bin/sh', '-c', 'echo pwned > ../outside/stolen.txt'],
      cwd: writable,
      writable: [{ directory: writable }],
      network: false,
    });
    expect(outside.status).not.toBe(0);
    expect(`${outside.stdout}${outside.stderr}`).toContain('Read-only file system');
    expect(existsSync(join(sibling, 'stolen.txt'))).toBe(false);
  });

  it.skipIf(!HAS_BWRAP)('binds only the declared paths, not the tree they sit in', () => {
    const root = scratch('bind');
    const declared = join(root, 'src');
    const sibling = join(root, 'other');
    mkdirSync(declared);
    mkdirSync(sibling);

    const result = bwrapSandbox({
      command: ['/bin/sh', '-c', 'echo a > src/a.txt; echo b > other/b.txt'],
      cwd: root,
      writable: [{ directory: declared }],
      network: false,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(declared, 'a.txt'), 'utf8').trim()).toBe('a');
    expect(existsSync(join(sibling, 'b.txt'))).toBe(false);
  });

  it.skipIf(!HAS_BWRAP)('has no network inside the sandbox', () => {
    const root = scratch('net');
    const result = bwrapSandbox({
      command: ['/bin/sh', '-c', 'exec 3<>/dev/tcp/1.1.1.1/80'],
      cwd: root,
      writable: [{ directory: root }],
      network: false,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /Network is unreachable|Connection refused|No such file/
    );
  });

  it.skipIf(!HAS_BWRAP)('lands a git apply onto an existing file, which a file bind cannot', async () => {
    // Regression, found by running the CLI rather than by a test. Binding the
    // single declared *file* makes it a mount point, and `git apply` unlinks
    // before it rewrites: `EBUSY: Device or resource busy`. So the bind must be
    // the containing directory, and this asserts the whole path works.
    const root = seedRepo();
    const worktree = join(root, '.terminal221b', 'tasks', 'task-apply');
    mkdirSync(join(root, '.terminal221b', 'tasks'), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', '--force', worktree, 'HEAD'], {
      cwd: root,
    });
    try {
      const mounts = await bindMounts(worktree, await resolveWritablePaths(worktree, ['src/app.txt']));
      // The mount is the directory, never the file.
      expect(mounts).toEqual([{ directory: join(worktree, 'src') }]);

      const applied = bwrapSandbox({
        command: ['git', 'apply', '--'],
        cwd: worktree,
        writable: mounts,
        stdin: PATCH,
        network: false,
      });
      expect(`${applied.stdout}${applied.stderr}`).not.toMatch(/Device or resource busy/);
      expect(applied.status).toBe(0);
      expect(readFileSync(join(worktree, 'src/app.txt'), 'utf8')).toBe('changed\n');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
      execFileSync('git', ['worktree', 'prune'], { cwd: root });
    }
  });

  it.skipIf(!HAS_BWRAP)('binds a path that does not exist yet to its nearest existing directory', async () => {
    const root = seedRepo();
    // `src/new/deep.txt` does not exist. The mount still has to be somewhere real.
    expect(await bindTargetFor(root, 'src/new/deep.txt')).toBe(join(root, 'src'));
  });

  it('refuses to resolve a sandbox when bubblewrap is missing and no opt-in is given', () => {
    // A silent fallback to the host would reintroduce F17 while still reporting
    // success, so this must throw rather than degrade.
    const original = process.env.PATH;
    process.env.PATH = scratch('nopath');
    try {
      expect(() => resolveSandbox({})).toThrow(/bwrap is not available/);
      expect(resolveSandbox({ allowUnsandboxed: true }).isolated).toBe(false);
      const fake: Sandbox = () => ({ status: 0, stdout: '', stderr: '' });
      expect(resolveSandbox({ sandbox: fake }).sandbox).toBe(fake);
    } finally {
      process.env.PATH = original as string;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A contract cannot declare a write set that escapes the workspace            */
/* -------------------------------------------------------------------------- */

describe('a declared write set cannot escape the workspace', () => {
  it('refuses a lexically clean path whose parent is a symlink out of the workspace', async () => {
    const root = seedRepo();
    const outside = scratch('outside');
    symlinkSync(outside, join(root, 'escape'), 'dir');
    // `escape/app.txt` is lexically clean: no `..`, no leading slash, not `.git`.
    // The lexical tier cannot see this, which is the documented limit of that
    // tier, and it is why the async tier exists.
    await expect(resolveWritablePaths(root, ['escape/app.txt'])).rejects.toThrow(
      /traverses a symbolic link/
    );
    expect(existsSync(join(outside, 'app.txt'))).toBe(false);
  });

  it('refuses an absolute path, a parent escape, and .git at parse time', () => {
    expect(() => parseTaskContract(contractJson({ writablePaths: ['/etc/passwd'] }))).toThrow(
      /disallowed path/
    );
    expect(() => parseTaskContract(contractJson({ writablePaths: ['../outside'] }))).toThrow(
      /disallowed path/
    );
    expect(() => parseTaskContract(contractJson({ writablePaths: ['.git/config'] }))).toThrow(
      /disallowed path/
    );
  });

  it('refuses writable paths without a capability that permits writing', () => {
    expect(() => parseTaskContract(contractJson({ capability: 'observe' }))).toThrow(
      /writablePaths require the modify or submit_publish capability/
    );
  });

  it('resolves a declared path to an absolute one inside the workspace', async () => {
    const root = seedRepo();
    expect(await resolveWritablePaths(root, ['src/app.txt'])).toEqual([
      { declared: 'src/app.txt', absolute: join(root, 'src/app.txt') },
    ]);
  });
});

describe('a changed path outside the declared write set is named', () => {
  it('reports exactly the paths the contract did not declare writable', () => {
    const root = seedRepo();
    expect(pathsOutsideWritable(root, ['src/app.txt'], ['src/app.txt'])).toEqual([]);
    expect(pathsOutsideWritable(root, ['src/other.txt'], ['src'])).toEqual([]);
    expect(pathsOutsideWritable(root, ['README.md'], ['src/app.txt'])).toEqual(['README.md']);
    expect(pathsOutsideWritable(root, ['src/app.txt', 'README.md'], ['src/app.txt'])).toEqual([
      'README.md',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The read set is the only thing a task can see                              */
/* -------------------------------------------------------------------------- */

describe('a task sees its read set and nothing else', () => {
  it('copies the declared refs and leaves the rest of the workspace out', async () => {
    const root = seedRepo();
    writeFileSync(join(root, 'notes.txt'), 'untracked notes\n', 'utf8');
    const worktree = await createTaskWorktree(root, 'task-reads');
    try {
      expect(await materializeReadSet(worktree, root, ['src/app.txt'], root)).toEqual([
        { ref: 'src/app.txt', path: 'src/app.txt', from: join(root, 'src/app.txt') },
      ]);
      expect(readFileSync(join(worktree, 'src/app.txt'), 'utf8')).toBe('original\n');
      // The worktree is a fresh checkout, so the untracked file never arrives.
      // A ref that is not named is not present: the read set is enforced by
      // absence rather than by a promise in a system prompt.
      expect(existsSync(join(worktree, 'notes.txt'))).toBe(false);
    } finally {
      await removeTaskWorktree(root, worktree);
    }
  });

  it('refuses a remote read ref, because nothing here fetches a source', async () => {
    const root = seedRepo();
    const worktree = await createTaskWorktree(root, 'task-remote');
    try {
      await expect(
        materializeReadSet(worktree, root, ['https://example.invalid/spec.md'], root)
      ).rejects.toThrow(/remote uri; nothing in a task run fetches a source/);
    } finally {
      await removeTaskWorktree(root, worktree);
    }
  });

  it('refuses two refs that would land on the same path in the worktree', async () => {
    const root = seedRepo();
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'same.md'), 'from a\n', 'utf8');
    writeFileSync(join(root, 'b', 'same.md'), 'from b\n', 'utf8');
    const worktree = await createTaskWorktree(root, 'task-collide');
    try {
      await expect(
        materializeReadSet(
          worktree,
          root,
          [`file://${join(root, 'a', 'same.md')}`, `file://${join(root, 'b', 'same.md')}`],
          root
        )
      ).rejects.toThrow(/both land at same\.md/);
    } finally {
      await removeTaskWorktree(root, worktree);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A task run reports what happened and leaves nothing behind                   */
/* -------------------------------------------------------------------------- */

describe('a task run produces a candidate change and no applied one', () => {
  it('completes with a diff and leaves the workspace untouched', async () => {
    const root = seedRepo();
    const { sandbox, requests } = recordingSandbox(0);
    const report = await runTask(parseTaskContract(contractJson()), {
      workspace: root,
      sandbox,
      propose: async () => ({ patch: PATCH }),
    });
    expect(report.status).toBe('completed');
    expect(report.changedPaths).toEqual(['src/app.txt']);
    expect(report.patchDigest).toBe(sha256(PATCH));
    expect(report.failures).toEqual([]);
    expect(report.isolated).toBe(false);
    expect(report.envelope.status).toBe('completed');
    expect(readFileSync(join(root, 'src/app.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(root, '.terminal221b/tasks/task-1'))).toBe(false);
    // No acceptance check was declared, so the sandbox was never consulted.
    expect(requests).toEqual([]);
  });

  it('runs every acceptance check through the sandbox and fails visibly', async () => {
    const root = seedRepo();
    const seen: SandboxRequest[] = [];
    const report = await runTask(
      parseTaskContract(contractJson({ acceptanceChecks: ['test -f src/app.txt', 'false'] })),
      {
        workspace: root,
        sandbox: (request) => {
          seen.push(request);
          const refuses = request.command.join(' ').includes('false');
          return { status: refuses ? 1 : 0, stdout: '', stderr: refuses ? 'check said no' : '' };
        },
        propose: async () => ({ patch: '' }),
      }
    );
    expect(report.status).toBe('failed');
    expect(report.checks.map((check) => check.check)).toEqual(['test -f src/app.txt', 'false']);
    expect(report.checks.map((check) => check.passed)).toEqual([true, false]);
    expect(report.failures.join(' ')).toContain('acceptance check failed: false');
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.network === false)).toBe(true);
    expect(report.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['task_started', 'check_started', 'check_finished'])
    );
  });

  it.skipIf(!HAS_BWRAP)('fails a check that writes outside the bind, and lands nothing', async () => {
    const root = seedRepo();
    const outside = scratch('check-escape');
    const report = await runTask(
      parseTaskContract(contractJson({ acceptanceChecks: [`echo pwned > ${outside}/pwned.txt`] })),
      {
        workspace: root,
        propose: async () => ({ patch: '' }),
      }
    );
    expect(report.status).toBe('failed');
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
    expect(report.isolated).toBe(true);
  });

  it('refuses a diff that touches a path the contract did not declare writable', async () => {
    const root = seedRepo();
    const { sandbox } = recordingSandbox(0);
    const report = await runTask(parseTaskContract(contractJson()), {
      workspace: root,
      sandbox,
      propose: async () => ({
        patch:
          'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n' +
          '@@ -1 +1 @@\n-# seed\n+# changed\n',
      }),
    });
    expect(report.status).toBe('failed');
    expect(report.failures.join(' ')).toMatch(
      /README\.md, which the contract does not declare writable/
    );
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# seed\n');
  });

  it('blocks rather than running when the declared write set cannot be resolved', async () => {
    const root = seedRepo();
    symlinkSync(scratch('outside'), join(root, 'escape'), 'dir');
    const { sandbox, requests } = recordingSandbox(0);
    const report = await runTask(
      parseTaskContract(contractJson({ writablePaths: ['escape/app.txt'] })),
      { workspace: root, sandbox, propose: async () => ({ patch: '' }) }
    );
    expect(report.status).toBe('blocked');
    expect(report.failures.join(' ')).toMatch(/traverses a symbolic link/);
    expect(requests).toEqual([]);
    expect(existsSync(join(root, '.terminal221b/tasks/task-1'))).toBe(false);
  });

  it('tears the worktree down even when the provider throws', async () => {
    const root = seedRepo();
    const { sandbox } = recordingSandbox(0);
    const report = await runTask(parseTaskContract(contractJson()), {
      workspace: root,
      sandbox,
      propose: async () => {
        throw new Error('provider refused');
      },
    });
    expect(report.status).toBe('failed');
    expect(report.failures.join(' ')).toContain('provider refused');
    expect(existsSync(join(root, '.terminal221b/tasks/task-1'))).toBe(false);
  });

  it('hands the model the read-set bytes and a system prompt for the role', async () => {
    const root = seedRepo();
    const { sandbox } = recordingSandbox(0);
    let seen: { system: string; prompt: string; context: string } | undefined;
    await runTask(parseTaskContract(contractJson({ readRefs: ['src/app.txt'] })), {
      workspace: root,
      sandbox,
      propose: async (request) => {
        seen = { system: request.system, prompt: request.prompt, context: request.context };
        return { patch: '' };
      },
    });
    expect(seen?.context).toContain('--- src/app.txt ---\noriginal');
    expect(seen?.prompt).toContain('The only paths you may change: src/app.txt');
    expect(seen?.system).toContain('Never execute commands.');
  });
});

/* -------------------------------------------------------------------------- */
/* Landing a change needs a signature over the exact bytes                     */
/* -------------------------------------------------------------------------- */

async function seedStore(label: string): Promise<string> {
  const root = scratch(label);
  await initStore(root, NOW);
  trustKey(root, { keyId: KEY_ID, publicKey }, NOW);
  return root;
}

function signedApproval(
  storeRoot: string,
  signer: typeof privateKey = privateKey,
  over: Partial<ApprovalRecord> = {}
): ApprovalRecord {
  const approval = {
    version: 1,
    approvalId: 'approval-1',
    caseId: 'case-1',
    taskId: 'task-1',
    effect: TASK_DIFF_EFFECT,
    payloadDigest: sha256(PATCH),
    decision: 'approved',
    decidedBy: 'human',
    decidedAt: NOW,
    ...over,
  } as ApprovalRecord;
  return { ...approval, attestation: signRecord('approval', approval, signer, KEY_ID, NOW) };
}

describe('landing a change needs a signature over the exact bytes', () => {
  it('applies a diff whose approval is signed by a key the store trusts', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-ok');
    const { sandbox, requests } = recordingSandbox(0);
    const applied = await applyTaskDiff({
      workspace: root,
      storeRoot,
      contract: parseTaskContract(contractJson()),
      patch: PATCH,
      approval: signedApproval(storeRoot),
      sandbox,
    });
    expect(applied).toEqual(['src/app.txt']);
    expect(requests[0].command.slice(0, 2)).toEqual(['git', 'apply']);
    expect(requests[0].command).toContain('--check');
    expect(requests[1].command).not.toContain('--check');
    // The patch reached git over stdin, not as an argument.
    expect(requests[0].stdin).toBe(PATCH);
    expect(requests.every((request) => request.network === false)).toBe(true);
  });

  it('refuses when there is no store, and applies nothing', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-missing');
    const { sandbox, requests } = recordingSandbox(0);
    await expect(
      applyTaskDiff({
        workspace: root,
        storeRoot: join(root, 'no-such-store'),
        contract: parseTaskContract(contractJson()),
        patch: PATCH,
        approval: signedApproval(storeRoot),
        sandbox,
      })
    ).rejects.toThrow(/no case store at/);
    expect(requests).toEqual([]);
    expect(readFileSync(join(root, 'src/app.txt'), 'utf8')).toBe('original\n');
  });

  it('refuses a signature from a key the store was never told about', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-stranger');
    const { sandbox, requests } = recordingSandbox(0);
    await expect(
      applyTaskDiff({
        workspace: root,
        storeRoot,
        contract: parseTaskContract(contractJson()),
        patch: PATCH,
        approval: signedApproval(storeRoot, STRANGER.privateKey),
        sandbox,
      })
    ).rejects.toThrow(/does not carry a signature that verifies/);
    expect(requests).toEqual([]);
    expect(readFileSync(join(root, 'src/app.txt'), 'utf8')).toBe('original\n');
  });

  it('refuses an approval that commits to a different diff', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-otherdiff');
    const { sandbox, requests } = recordingSandbox(0);
    await expect(
      applyTaskDiff({
        workspace: root,
        storeRoot,
        contract: parseTaskContract(contractJson()),
        patch: PATCH,
        approval: signedApproval(storeRoot, privateKey, {
          payloadDigest: sha256('a different diff entirely'),
        }),
        sandbox,
      })
    ).rejects.toThrow(/this diff digests to/);
    expect(requests).toEqual([]);
  });

  it('refuses an approval for another task, another effect, or another decision', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-scope');
    const { sandbox, requests } = recordingSandbox(0);
    const base = {
      workspace: root,
      storeRoot,
      contract: parseTaskContract(contractJson()),
      patch: PATCH,
      sandbox,
    };
    await expect(
      applyTaskDiff({ ...base, approval: signedApproval(storeRoot, privateKey, { taskId: 'task-2' }) })
    ).rejects.toThrow(/is for task task-2, not task-1/);
    await expect(
      applyTaskDiff({
        ...base,
        approval: signedApproval(storeRoot, privateKey, { effect: 'merge main' }),
      })
    ).rejects.toThrow(/names the effect "merge main"/);
    await expect(
      applyTaskDiff({
        ...base,
        approval: signedApproval(storeRoot, privateKey, { decision: 'rejected' }),
      })
    ).rejects.toThrow(/decided rejected/);
    expect(requests).toEqual([]);
    expect(readFileSync(join(root, 'src/app.txt'), 'utf8')).toBe('original\n');
  });

  it('refuses an approval a machine recorded rather than a human', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-agent');
    const { sandbox, requests } = recordingSandbox(0);
    await expect(
      applyTaskDiff({
        workspace: root,
        storeRoot,
        contract: parseTaskContract(contractJson()),
        patch: PATCH,
        approval: { ...signedApproval(storeRoot), decidedBy: 'agent' },
        sandbox,
      })
    ).rejects.toThrow(/decidedBy must be human/);
    expect(requests).toEqual([]);
  });

  it('leaves the change unapplied when the sandbox refuses the apply', async () => {
    const root = seedRepo();
    const storeRoot = await seedStore('store-refused');
    const calls: string[] = [];
    const sandbox: Sandbox = (request) => {
      calls.push(request.command.join(' '));
      return request.command.includes('--check')
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'Read-only file system' };
    };
    await expect(
      applyTaskDiff({
        workspace: root,
        storeRoot,
        contract: parseTaskContract(contractJson()),
        patch: PATCH,
        approval: signedApproval(storeRoot),
        sandbox,
      })
    ).rejects.toThrow(/git apply failed: Read-only file system/);
    expect(calls).toHaveLength(2);
    expect(readFileSync(join(root, 'src/app.txt'), 'utf8')).toBe('original\n');
  });
});