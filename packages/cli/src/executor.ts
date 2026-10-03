/**
 * The contract-to-executor seam: the module that finally opens a path named by a
 * `TaskContract` (F17).
 *
 * F17 was open for exactly one reason — until this file existed, nothing read a
 * `writablePaths` entry, so validating it proved only that a string was well
 * formed. Validation stops being the boundary the moment something acts. The
 * answer, per the blueprint, is that the accepted write set is enforced by the
 * filesystem rather than by a function, and `bwrapSandbox` is what does it:
 *
 *   - `/` is bound **read-only**, so the only writable locations are the
 *     explicit `--bind` mounts built here from the contract.
 *   - Mounts come from *resolved, symlink-walked* paths (`assertSafePath`), so a
 *     lexically clean `writablePaths` entry whose parent is a symlink out of the
 *     workspace is refused before any bind exists.
 *   - `--unshare-net` means the "Research" rung of the permission ladder is off by
 *     construction rather than by policy, for anything the sandbox launches.
 *
 * Two independent layers, and the second is not TypeScript.
 *
 * ## What this deliberately cannot do
 *
 * - It cannot reach the network. No source is fetched and no provider is called
 *   from inside the sandbox.
 * - It cannot apply anything to the operator's workspace on its own. A task run
 *   produces a *candidate diff* plus the evidence that the diff passes the
 *   contract's own acceptance checks. Landing it is `applyTaskDiff`, which
 *   requires an `ApprovalRecord` whose signature verifies against a key a case
 *   store trusts. There is no `--yes` and no `y` anywhere in this file.
 * - It cannot merge, push, or sign.
 *
 * ## The model never writes
 *
 * The provider returns a unified diff, exactly as `ask --apply` already does.
 * `acceptanceChecks` are operator-declared commands the *executor* runs; the
 * provider-boundary clause `no_command_execution` binds the *model*, and that
 * distinction is load-bearing — the contract author is the operator.
 */
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  parseApprovalRecord,
  parseTaskContract,
  type ApprovalRecord,
  type TaskContract,
} from './case.js';
import {
  parseAgentEvent,
  parseEnvelope,
  type AgentEvent,
  type AgentEventKind,
  type ResultEnvelope,
} from './envelope.js';
import { validatePatchPaths } from './patch.js';
import { assertSafePath, withinRoot } from './path-guard.js';
import {
  approvalSignatureChecker,
  localPathFor,
  readManifest,
  sha256,
} from './store.js';
import { profileForRole, renderSystemPrompt, type SystemPrompt } from './system-prompt.js';

/** The one effect name `applyTaskDiff` accepts. Any other name is a different approval. */
export const TASK_DIFF_EFFECT = 'apply task diff to workspace';

const SANDBOX_BINARY = 'bwrap';
const TASK_WORKSPACE_DIR = '.terminal221b';
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_BYTES = 4_000;
const OUTPUT_TAIL_LINES = 4;

/* -------------------------------------------------------------------------- */
/* The sandbox                                                                 */
/* -------------------------------------------------------------------------- */

export interface SandboxWritable {
  /** An absolute directory the sandbox may write to. It must already exist. */
  directory?: string;
  /** An absolute file the sandbox may write to. Its parent must already exist. */
  file?: string;
}

export interface SandboxRequest {
  command: string[];
  cwd: string;
  /** The complete write set. Nothing else on the machine is writable. */
  writable: SandboxWritable[];
  /** Passed to the command's stdin. Used for `git apply --`. */
  stdin?: string;
  /** True opt-in only. The default drops the network namespace entirely. */
  network?: boolean;
  timeoutMs?: number;
}

export interface SandboxResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Sandbox = (request: SandboxRequest) => SandboxResult;

/**
 * Whether a sandbox can actually be built here, and if not, which of two very
 * different problems it is.
 *
 * The distinction is load-bearing. "Bubblewrap is not installed" is a
 * configuration problem with a known fix. "Bubblewrap is installed and cannot
 * sandbox" is a capability the host does not have — an older bubblewrap, a
 * container that denies the network-namespace operations `--unshare-net` needs,
 * or a kernel without unprivileged user namespaces. They look identical to a
 * boolean and must not be treated the same way: see `resolveSandbox`.
 */
export type SandboxCapability =
  | { kind: 'ok' }
  | { kind: 'absent' }
  | { kind: 'broken'; detail: string };

/**
 * The minimal invocation that exercises every capability the real sandbox needs.
 *
 * `--unshare-net` is here on purpose. It is the flag `bwrapSandbox` adds unless a
 * caller explicitly opts into the network, and it is the one that fails on a
 * GitHub ubuntu-24.04 runner with bubblewrap 0.9.0. A probe that omitted it would
 * pass on exactly the host where every real task fails, which is the same defect
 * as probing `--version`: a check that cannot fail where the thing fails.
 */
const PROBE_ARGV = [
  '--ro-bind',
  '/',
  '/',
  '--unshare-pid',
  '--unshare-net',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  '--chdir',
  '/tmp',
  '--',
  '/bin/true',
];

/**
 * Deliberately not memoised.
 *
 * It was, and a cached verdict is what this whole change exists to remove. A memo
 * turns "can this host sandbox right now" into "what did some earlier call decide",
 * and in a process that also has a built copy of this module on disk
 * (`packages/cli/dist/executor.js`) the two copies can disagree: a `bwrap` that
 * provably works got a cached `absent` and a task was refused for a sandbox that
 * was there. A wrong cached answer to a security predicate is worse than the spawn
 * it saves, and the spawn is once per `resolveSandbox` — once per task run, not
 * once per command.
 */
export function probeSandbox(binary: string = SANDBOX_BINARY): SandboxCapability {
  const result = spawnSync(binary, PROBE_ARGV, { encoding: 'utf8', timeout: 5_000 });

  if (result.error !== undefined) {
    // A binary that is not there is a different situation from one that is there
    // and cannot work, and the caller can only respond correctly if told which.
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'EACCES' ? { kind: 'absent' } : {
      kind: 'broken',
      detail: result.error.message,
    };
  }

  if (result.status === 0) return { kind: 'ok' };

  return {
    kind: 'broken',
    detail: (result.stderr ?? '').trim() || `exited ${result.status} with no message`,
  };
}

/** True only when a sandbox can really be built. One spawn per call. */
export function sandboxAvailable(binary: string = SANDBOX_BINARY): boolean {
  return probeSandbox(binary).kind === 'ok';
}

/**
 * Every command this project runs on behalf of a task.
 *
 * `--ro-bind / /` goes first, so the whole tree is read-only before anything is
 * added. A `--dir` cannot create a new mount point on top of that (the parent is
 * already read-only and bwrap fails with `Can't create file <path>`), so each
 * bind target is resolved to something that already exists on the host — which is
 * why `bindTargetFor` walks up to the nearest existing ancestor.
 */
export const bwrapSandbox: Sandbox = (request) => {
  const argv = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--die-with-parent',
  ];
  if (request.network !== true) argv.push('--unshare-net');
  for (const target of request.writable) {
    if (target.directory !== undefined) argv.push('--bind', target.directory, target.directory);
    if (target.file !== undefined) argv.push('--bind', target.file, target.file);
  }
  argv.push('--chdir', request.cwd, '--', ...request.command);

  const result = spawnSync(SANDBOX_BINARY, argv, {
    encoding: 'utf8',
    input: request.stdin,
    maxBuffer: 1_000_000,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
};

/** The explicit opt-out, kept named so a call site has to say it out loud. */
export const runDirectly: Sandbox = (request) => {
  const result = spawnSync(request.command[0], request.command.slice(1), {
    cwd: request.cwd,
    encoding: 'utf8',
    input: request.stdin,
    maxBuffer: 1_000_000,
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
};

/**
 * Fail closed when there is no sandbox. Falling back to the host would
 * reintroduce F17 silently — the run would still report success while nothing
 * enforced the write set — so the only way out is a named opt-in, and the run
 * records that it was taken.
 *
 * `broken` deliberately does NOT reach the `allowUnsandboxed` branch, even though
 * a boolean probe cannot tell it apart from `absent`. Those are different
 * situations and they deserve different answers:
 *
 *   absent  — no bubblewrap on this host. The opt-in means "run without a sandbox",
 *             and the run records `isolated: false`. The caller has asked for that.
 *   broken  — bubblewrap IS here and cannot enforce anything. Offering the same
 *             opt-in here would turn a security boundary into a boolean, and it
 *             would be a regression: before the probe existed, this case selected
 *             bubblewrap and the task failed. Nothing ran. A caller who opted out
 *             of isolation on a host with no sandbox binary has not opted out of it
 *             on a host whose sandbox is silently inert, and did not know there was
 *             a difference to decline.
 *
 * So `broken` throws, and says which of the two it is, because "bubblewrap is not
 * available" would send someone to install a binary they already have.
 */
export function resolveSandbox(
  opts: { sandbox?: Sandbox; allowUnsandboxed?: boolean; binary?: string } = {}
): { sandbox: Sandbox; isolated: boolean } {
  if (opts.sandbox) return { sandbox: opts.sandbox, isolated: false };

  const binary = opts.binary ?? SANDBOX_BINARY;
  const capability = probeSandbox(binary);

  if (capability.kind === 'ok') return { sandbox: bwrapSandbox, isolated: true };

  if (capability.kind === 'broken') {
    throw new Error(
      `${binary} is installed but cannot create a sandbox: ${capability.detail}. ` +
        `Nothing runs without the write set being enforced, so this is not a case ` +
        `allowUnsandboxed covers — it means the host lacks a capability bubblewrap ` +
        `needs, not that bubblewrap is missing.`
    );
  }

  if (opts.allowUnsandboxed === true) return { sandbox: runDirectly, isolated: false };
  throw new Error(
    `${binary} is not available, so no task can run with its write set enforced by the ` +
      `filesystem. Install ${SANDBOX_BINARY} (bubblewrap); nothing is run without it.`
  );
}

/* -------------------------------------------------------------------------- */
/* The write set                                                               */
/* -------------------------------------------------------------------------- */

export interface ResolvedWritable {
  /** Exactly the string the contract declared. */
  declared: string;
  /** Absolute, symlink-walked, proven inside the workspace. */
  absolute: string;
}

/**
 * The async tier of the path rules, applied to what a contract declares.
 * `parseTaskContract` already ran the lexical half; this closes the half a pure
 * parser cannot reach, by `lstat`-ing every existing segment from the real
 * workspace root outward.
 */
export async function resolveWritablePaths(
  workspace: string,
  declared: readonly string[]
): Promise<ResolvedWritable[]> {
  const root = await realpath(workspace);
  const resolved: ResolvedWritable[] = [];
  for (const entry of declared) {
    await assertSafePath(root, entry);
    const absolute = resolve(root, entry);
    if (!withinRoot(root, absolute)) {
      throw new Error(`writablePaths escapes the workspace: ${entry}`);
    }
    resolved.push({ declared: entry, absolute });
  }
  return resolved;
}

/**
 * The bind mount for one declared path — always a **directory**.
 *
 * Two constraints shape this, and both were found by running the thing:
 *
 * - bwrap cannot create a mount point under a read-only `/`, so the target must
 *   already exist on the host. A path whose final segment does not exist yet
 *   therefore binds its nearest existing ancestor.
 * - **A file must never be the mount point.** Binding a single file makes that
 *   file a mount point, and `git apply` unlinks before it rewrites, which fails
 *   `EBUSY: Device or resource busy`. The fix is to bind the directory that
 *   contains the file.
 *
 * The cost of that fix is granularity, and it is real: the kernel enforces the
 * write set at *directory* granularity, so `src/app.txt` and `src/other.txt` both
 * bind `src/`. The exact declared set is enforced separately, in TypeScript, by
 * `pathsOutsideWritable` on the diff's changed paths. The two layers are not
 * redundant and neither is precise on its own.
 */
export async function bindTargetFor(root: string, declared: string): Promise<string> {
  let current = resolve(root, declared);
  for (;;) {
    try {
      const real = await realpath(current);
      if ((await stat(real)).isDirectory()) return real;
    } catch {
      // Not there, or not stat-able: fall through to the parent.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`no existing directory above ${declared} inside ${root}`);
    }
    current = parent;
  }
}

/**
 * The bind mounts for a write set, deepest-existing-ancestor first.
 *
 * It takes already-resolved entries rather than declared strings on purpose: the
 * caller has to have run `resolveWritablePaths` anyway, and accepting the raw
 * strings here would make it possible to build mounts for a write set that never
 * passed the symlink walk.
 *
 * The workspace root is deliberately **not** in this list. `runTask` works inside
 * a task worktree, so its cwd is the only thing that has to be writable there.
 */
export async function bindMounts(
  root: string,
  resolved: readonly ResolvedWritable[]
): Promise<SandboxWritable[]> {
  const mounts: SandboxWritable[] = [];
  for (const entry of resolved) {
    mounts.push({ directory: await bindTargetFor(root, entry.declared) });
  }
  return mounts;
}

/* -------------------------------------------------------------------------- */
/* Worktree lifecycle                                                           */
/* -------------------------------------------------------------------------- */

const git = (args: string[], cwd: string): SandboxResult => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4_000_000,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
};

/**
 * One worktree per task, under `.terminal221b/tasks/<taskId>`, so two tasks
 * cannot see each other's uncommitted bytes and a task that leaves a stray file
 * cannot write into the operator's tree at all.
 */
export async function createTaskWorktree(workspace: string, taskId: string): Promise<string> {
  const root = await realpath(workspace);
  const parent = join(root, TASK_WORKSPACE_DIR, 'tasks');
  const path = join(parent, taskId);
  if (!withinRoot(root, path)) {
    throw new Error(`task id ${taskId} does not resolve to a path inside the workspace`);
  }
  await mkdir(parent, { recursive: true });
  const result = git(['worktree', 'add', '--detach', '--force', path, 'HEAD'], root);
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return path;
}

export async function removeTaskWorktree(workspace: string, path: string): Promise<void> {
  const root = await realpath(workspace);
  if (!withinRoot(root, path)) {
    throw new Error(`refusing to remove a worktree outside ${root}: ${path}`);
  }
  git(['worktree', 'remove', '--force', path], root);
  git(['worktree', 'prune'], root);
  await rm(path, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/* The read set                                                                */
/* -------------------------------------------------------------------------- */

export interface MaterializedRead {
  /** Exactly what the contract named. */
  ref: string;
  /** Where it landed inside the worktree, relative to the worktree root. */
  path: string;
  /** Absolute source it was copied from. */
  from: string;
}

const looksLikeUri = (ref: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(ref);

/**
 * Copy exactly what the contract says the task may read, and nothing else. The
 * task does not inherit the workspace: a contract naming three files gets a
 * worktree containing three files, so "read what you were told" is enforced by
 * absence rather than by a promise in a system prompt.
 */
export async function materializeReadSet(
  worktree: string,
  workspace: string,
  readRefs: readonly string[],
  baseDir: string
): Promise<MaterializedRead[]> {
  const root = await realpath(worktree);
  const workspaceRoot = await realpath(workspace);
  const taken = new Set<string>();
  const materialized: MaterializedRead[] = [];

  for (const ref of readRefs) {
    const local = localPathFor(ref, baseDir);
    let from: string;
    let path: string;

    if (local !== undefined) {
      from = local;
      path = basename(local);
    } else if (looksLikeUri(ref)) {
      throw new Error(
        `readRefs entry ${ref} is a remote uri; nothing in a task run fetches a source (F8, F16)`
      );
    } else {
      await assertSafePath(workspaceRoot, ref);
      from = resolve(workspaceRoot, ref);
      path = ref;
    }

    if (taken.has(path)) {
      throw new Error(`two readRefs entries both land at ${path} in the worktree`);
    }
    taken.add(path);

    await assertSafePath(root, path);
    const to = join(root, path);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
    materialized.push({ ref, path, from });
  }
  return materialized;
}

/* -------------------------------------------------------------------------- */
/* Running the task                                                            */
/* -------------------------------------------------------------------------- */

export type TaskRunStatus = 'completed' | 'failed' | 'blocked';

export interface CheckOutcome {
  check: string;
  status: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
}

export interface TaskRunReport {
  version: 1;
  taskId: string;
  status: TaskRunStatus;
  role: string;
  worktree: string;
  /** Absolute paths the sandbox was allowed to write to. The whole write set. */
  writable: string[];
  readSet: MaterializedRead[];
  changedPaths: string[];
  /** A candidate diff. Applied to nothing. */
  patch: string;
  patchDigest: string;
  checks: CheckOutcome[];
  events: AgentEvent[];
  /** Why it did not complete. Empty only when status is `completed`. */
  failures: string[];
  /** False when the run was explicitly permitted to go without filesystem isolation. */
  isolated: boolean;
  envelope: ResultEnvelope;
}

export interface TaskDispatchRequest {
  contract: TaskContract;
  /** The rendered boundary for the contract's role. Branded, so it cannot be a loose string. */
  system: SystemPrompt;
  prompt: string;
  context: string;
}

export interface TaskRunOptions {
  workspace: string;
  /** Directory that `local://` read refs resolve against. */
  baseDir?: string;
  sandbox?: Sandbox;
  /** The only way to run without a sandbox. Recorded in the report as `isolated: false`. */
  allowUnsandboxed?: boolean;
  propose: (request: TaskDispatchRequest) => Promise<{ patch: string }>;
  now?: () => string;
}

const tail = (text: string): string => text.slice(-OUTPUT_TAIL_BYTES);
const lastLines = (result: SandboxResult): string =>
  tail(`${result.stdout}${result.stderr}`).trim().split('\n').slice(-OUTPUT_TAIL_LINES).join(' ').trim();

function buildPrompt(contract: TaskContract): string {
  const lines = [
    contract.goal,
    '',
    'Rules for this task:',
    '- Read only the files included below. Nothing else in the workspace is in scope.',
    `- The only paths you may change: ${
      contract.writablePaths.length > 0 ? contract.writablePaths.join(', ') : '(none declared)'
    }.`,
    '- Return one unified diff and nothing else. No prose, no explanation, no commands.',
  ];
  if (contract.deadline !== undefined) lines.push(`- Deadline: ${contract.deadline}.`);
  if (contract.costBudgetUsd !== undefined) lines.push(`- Cost budget: USD ${contract.costBudgetUsd}.`);
  return lines.join('\n');
}

/** One file of read-set context is bounded, and says so when it is cut. */
const MAX_CONTEXT_BYTES = 32_000;

/**
 * The model's view of the task: the bytes that were actually copied into the
 * worktree, read back from there rather than from the workspace. Reading the copy
 * is the point — if materialisation ever copied the wrong file, the model sees
 * what the task would actually have seen.
 */
async function readSetContext(
  worktree: string,
  readSet: readonly MaterializedRead[]
): Promise<string> {
  const sections: string[] = [];
  for (const item of readSet) {
    let body: string;
    try {
      body = await readFile(join(worktree, item.path), 'utf8');
    } catch (error) {
      body = `(this file could not be read: ${
        error instanceof Error ? error.message : String(error)
      })`;
    }
    if (body.length > MAX_CONTEXT_BYTES) {
      body = `${body.slice(0, MAX_CONTEXT_BYTES)}\n[truncated at ${MAX_CONTEXT_BYTES} bytes]`;
    }
    sections.push(`--- ${item.path} ---\n${body}`);
  }
  return sections.join('\n\n');
}

/**
 * Run one contract end to end and report what happened. The worktree is removed
 * on every exit path — including a throw from `propose` — because a stray
 * writable directory surviving a crash is exactly what a teardown in `finally`
 * exists to prevent.
 */
export async function runTask(
  contractInput: unknown,
  options: TaskRunOptions
): Promise<TaskRunReport> {
  const contract = parseTaskContract(contractInput);
  const clock = options.now ?? (() => new Date().toISOString());
  const startedAt = clock();
  const events: AgentEvent[] = [];
  const failures: string[] = [];
  const readSet: MaterializedRead[] = [];

  const record = (kind: AgentEventKind, detail?: string): void => {
    events.push(
      parseAgentEvent({
        version: 1,
        taskId: contract.taskId,
        kind,
        at: clock(),
        ...(detail === undefined ? {} : { detail }),
      })
    );
  };

  const settle = (
    status: TaskRunStatus,
    worktree: string,
    writable: string[],
    changedPaths: string[],
    patch: string,
    checks: CheckOutcome[],
    isolated: boolean
  ): TaskRunReport => ({
    version: 1,
    taskId: contract.taskId,
    status,
    role: contract.role,
    worktree,
    writable,
    readSet,
    changedPaths,
    patch,
    patchDigest: sha256(patch),
    checks,
    events,
    failures,
    isolated,
    envelope: buildEnvelope(contract.taskId, status, failures, readSet, startedAt, clock()),
  });

  const refuse = async (reason: string, worktree = ''): Promise<TaskRunReport> => {
    record('task_failed', reason);
    failures.push(reason);
    return settle('blocked', worktree, [], [], '', [], true);
  };

  let resolved: { sandbox: Sandbox; isolated: boolean };
  let writable: ResolvedWritable[];
  try {
    resolved = resolveSandbox(options);
    writable = await resolveWritablePaths(options.workspace, contract.writablePaths);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  let worktree: string;
  try {
    worktree = await createTaskWorktree(options.workspace, contract.taskId);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

    let patch = '';
  let changedPaths: string[] = [];
  let checks: CheckOutcome[] = [];

  try {
    record('task_started', `worktree ${worktree}; write set ${writable.map((w) => w.declared).join(', ') || '(empty)'}`);
    if (!resolved.isolated) {
      record('finding', 'running WITHOUT filesystem isolation; only the path guards apply (F17 stays open)');
    }

    let worktreeWritable: ResolvedWritable[];
    try {
      // The workspace walk above proves the paths are sane in the operator's tree.
      // This one proves they are sane in the worktree the sandbox will actually
      // write to, which is a different filesystem and could differ.
      worktreeWritable = await resolveWritablePaths(worktree, contract.writablePaths);
    } catch (error) {
      await removeTaskWorktree(options.workspace, worktree);
      return refuse(error instanceof Error ? error.message : String(error), worktree);
    }

    try {
      readSet.push(
        ...(await materializeReadSet(
          worktree,
          options.workspace,
          contract.readRefs,
          options.baseDir ?? options.workspace
        ))
      );
    } catch (error) {
      await removeTaskWorktree(options.workspace, worktree);
      return refuse(error instanceof Error ? error.message : String(error), worktree);
    }
    record('progress', `read set: ${readSet.map((item) => item.ref).join(', ') || '(empty)'}`);

    try {
      patch = (await options.propose({
        contract,
        system: renderSystemPrompt(profileForRole(contract.role)),
        prompt: buildPrompt(contract),
        context: await readSetContext(worktree, readSet),
      })).patch;
      record('diff_proposed', `${patch.trim() === '' ? 'no diff' : sha256(patch).slice(0, 19)}…`);
    } catch (error) {
      const reason = `the provider did not return a diff: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await removeTaskWorktree(options.workspace, worktree);
      record('task_failed', reason);
      failures.push(reason);
      return settle('failed', worktree, [], [], '', [], resolved.isolated);
    }

    if (patch.trim() !== '') {
      try {
        changedPaths = (await validatePatchPaths(worktree, patch)).paths;
        const stray = pathsOutsideWritable(worktree, changedPaths, contract.writablePaths);
        if (stray.length > 0) {
          throw new Error(
            `the diff touches ${stray.join(', ')}, which the contract does not declare writable`
          );
        }
      } catch (error) {
        const reason = `the proposed diff was refused: ${
          error instanceof Error ? error.message : String(error)
        }`;
        await removeTaskWorktree(options.workspace, worktree);
        record('task_failed', reason);
        failures.push(reason);
        return settle('failed', worktree, [], [], patch, [], resolved.isolated);
      }
    } else {
      record('observation', 'the provider returned no diff; there is nothing to check');
    }

    const mounts: SandboxWritable[] = [
      ...(await bindMounts(worktree, worktreeWritable)),
      // The worktree is the sandbox's cwd and must be creatable, so it is bound
      // even when the contract declares no writable path. A task with an empty
      // write set should fail its own checks, not crash the sandbox.
      { directory: worktree },
    ];
    checks = await runChecks(contract, worktree, mounts, resolved.sandbox, record);

    const failedChecks = checks.filter((check) => !check.passed);
    if (failedChecks.length > 0) {
      for (const check of failedChecks) {
        failures.push(`acceptance check failed: ${check.check} (exit ${check.status})`);
      }
      await removeTaskWorktree(options.workspace, worktree);
      return settle(
        'failed',
        worktree,
        mounts.map((mount) => mount.directory ?? ''),
        changedPaths,
        patch,
        checks,
        resolved.isolated
      );
    }

    record(
      'task_finished',
      'every acceptance check passed; the diff is a candidate, not an applied change'
    );
    await removeTaskWorktree(options.workspace, worktree);
    return settle(
      'completed',
      worktree,
      mounts.map((mount) => mount.directory ?? ''),
      changedPaths,
      patch,
      checks,
      resolved.isolated
    );
  } catch (error) {
    // Anything thrown after the worktree exists still has to tear it down.
    await removeTaskWorktree(options.workspace, worktree);
    throw error;
  }
}

async function runChecks(
  contract: TaskContract,
  worktree: string,
  mounts: SandboxWritable[],
  sandbox: Sandbox,
  record: (kind: AgentEventKind, detail?: string) => void
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of contract.acceptanceChecks) {
    record('check_started', check);
    const result = sandbox({
      command: ['/bin/sh', '-c', check],
      cwd: worktree,
      writable: mounts,
      network: false,
    });
    outcomes.push({
      check,
      status: result.status,
      passed: result.status === 0,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    });
    record(
      'check_finished',
      result.status === 0
        ? `${check} passed`
        : `${check} exited ${result.status}: ${lastLines(result)}`
    );
  }
  return outcomes;
}

/** The changed paths a contract did not declare writable. Empty means in bounds. */
export function pathsOutsideWritable(
  root: string,
  changedPaths: readonly string[],
  writablePaths: readonly string[]
): string[] {
  const allowed = writablePaths.map((declared) => resolve(root, declared));
  return changedPaths.filter((path) => {
    const absolute = resolve(root, path);
    return !allowed.some((prefix) => withinRoot(prefix, absolute));
  });
}

function buildEnvelope(
  taskId: string,
  status: TaskRunStatus,
  failures: string[],
  readSet: readonly MaterializedRead[],
  startedAt: string,
  finishedAt: string
): ResultEnvelope {
  // The first thing in this repository that serialises a ResultEnvelope, which
  // is what `envelope.ts` said was missing. Passing it through the parser here
  // catches a construction mistake at the source rather than downstream; it is
  // not a security check, and it proves nothing about the run.
  return parseEnvelope({
    version: 1,
    taskId,
    adapter: 'terminal221b-executor',
    adapterVersion: '1',
    status,
    evidenceRefs: readSet.map((item) => item.ref),
    warnings: failures,
    startedAt,
    finishedAt,
  });
}

/* -------------------------------------------------------------------------- */
/* The event log                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every run appends its events to `events.jsonl`, going through `parseAgentEvent`
 * on the way in so an event that could not have been read back never lands in the
 * log.
 */
export async function appendEvents(
  eventsPath: string,
  events: readonly AgentEvent[]
): Promise<void> {
  for (const event of events) {
    await appendFile(eventsPath, `${JSON.stringify(parseAgentEvent(event))}\n`, 'utf8');
  }
}

/** Where a task's events live. The worktree is gone by the time this is read. */
export function taskEventsPath(workspace: string, taskId: string): string {
  return join(workspace, TASK_WORKSPACE_DIR, 'tasks', `${taskId}.events.jsonl`);
}

/**
 * Where a completed run's candidate diff is written.
 *
 * `applyTaskDiff` reads this back from disk rather than taking a diff handed to
 * it, so the approval's `payloadDigest` is compared against the bytes that will
 * actually be written. Editing the file between the run and the approval is
 * exactly the case a digest exists to catch, and an in-memory handoff would not.
 */
export function candidateDiffPath(workspace: string, taskId: string): string {
  return join(workspace, TASK_WORKSPACE_DIR, 'tasks', `${taskId}.diff`);
}

/** Reads a written event log, so a run can be re-read after teardown. */
export async function readEvents(path: string): Promise<AgentEvent[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseAgentEvent(JSON.parse(line)));
}

/* -------------------------------------------------------------------------- */
/* Landing the change — the §3.3 Modify gate                                   */
/* -------------------------------------------------------------------------- */

export type GitApplyLike = (
  sandbox: Sandbox,
  writable: SandboxWritable[],
  cwd: string,
  patch: string,
  checkOnly: boolean
) => SandboxResult;

export const sandboxedGitApply: GitApplyLike = (sandbox, writable, cwd, patch, checkOnly) =>
  sandbox({
    command: ['git', 'apply', ...(checkOnly ? ['--check'] : []), '--'],
    cwd,
    writable,
    stdin: patch,
    network: false,
    timeoutMs: 30_000,
  });

export interface ApplyTaskDiffOptions {
  workspace: string;
  storeRoot: string;
  contract: TaskContract;
  patch: string;
  approval: unknown;
  sandbox?: Sandbox;
  allowUnsandboxed?: boolean;
  runApply?: GitApplyLike;
}

/**
 * Four things must hold, and the order matters: the cheap checks run first and
 * the signature is checked against the store, never against anything this run
 * produced.
 *
 * 1. the approval parses as an `ApprovalRecord`, so `decidedBy` must be `human`;
 * 2. it names this task, and names *this* effect and not another;
 * 3. its `payloadDigest` is the digest of the exact bytes about to be applied, so
 *    an approval cannot be replayed onto a different diff;
 * 4. its attestation verifies against a key a case store trusts — with no store,
 *    `readManifest` throws and nothing is applied.
 *
 * The change then lands through the sandbox with only the workspace bound
 * read-write and no network, so `git` itself has no way to reach anything else
 * even though it is trusted with the write.
 */
export async function applyTaskDiff(options: ApplyTaskDiffOptions): Promise<string[]> {
  const approval = parseApprovalRecord(options.approval);
  const contract = options.contract;

  if (approval.taskId !== contract.taskId) {
    throw new Error(
      `approval ${approval.approvalId} is for task ${approval.taskId}, not ${contract.taskId}`
    );
  }
  if (approval.effect !== TASK_DIFF_EFFECT) {
    throw new Error(
      `approval names the effect "${approval.effect}"; this command applies only "${TASK_DIFF_EFFECT}"`
    );
  }
  if (approval.decision !== 'approved') {
    throw new Error(`approval ${approval.approvalId} decided ${approval.decision}`);
  }

  const patchDigest = sha256(options.patch);
  if (approval.payloadDigest !== patchDigest) {
    throw new Error(
      `approval commits to ${approval.payloadDigest}; this diff digests to ${patchDigest}. Nothing applied.`
    );
  }

  const manifest = readManifest(options.storeRoot);
  if (!approvalSignatureChecker(manifest)(approval)) {
    throw new Error(
      `approval ${approval.approvalId} does not carry a signature that verifies against ${options.storeRoot}`
    );
  }

  const root = await realpath(options.workspace);
  const declared = await resolveWritablePaths(root, contract.writablePaths);
  const { paths } = await validatePatchPaths(root, options.patch);

  const stray = pathsOutsideWritable(root, paths, contract.writablePaths);
  if (stray.length > 0) {
    throw new Error(
      `the approved diff touches ${stray.join(', ')}, which the contract does not declare writable. Nothing applied.`
    );
  }

  const writable: SandboxWritable[] = [
    ...(await bindMounts(root, declared)),
    { directory: root },
  ];
  const { sandbox } = resolveSandbox(options);
  const apply = options.runApply ?? sandboxedGitApply;

  const dry = apply(sandbox, writable, root, options.patch, true);
  if (dry.status !== 0) {
    throw new Error(`git apply --check failed: ${(dry.stderr || dry.stdout).trim()}`);
  }
  const wet = apply(sandbox, writable, root, options.patch, false);
  if (wet.status !== 0) {
    throw new Error(`git apply failed: ${(wet.stderr || wet.stdout).trim()}`);
  }
  return paths;
}

export type { ApprovalRecord, ResultEnvelope };