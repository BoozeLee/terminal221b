import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export type GitApply = (
  workspace: string,
  patch: string,
  checkOnly: boolean
) => void;

function withinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

function isSensitivePath(path: string): boolean {
  const parts = path.split('/');
  const basename = parts.at(-1)!.toLowerCase();
  return (
    parts.some(
      (part) =>
        part.toLowerCase().startsWith('.env') ||
        part.toLowerCase() === '.ssh' ||
        part.toLowerCase() === 'secrets' ||
        part.toLowerCase() === 'credentials'
    ) ||
    /\.(pem|key|p12|pfx)$/i.test(basename)
  );
}

async function assertSafePath(root: string, path: string): Promise<void> {
  if (
    !path ||
    path.includes('"') ||
    path.includes('\\') ||
    isSensitivePath(path) ||
    isAbsolute(path) ||
    path.split('/').some((part) => part === '..' || part === '.git')
  ) {
    throw new Error(`Patch contains a disallowed path: ${path}`);
  }

  const destination = resolve(root, path);
  if (!withinRoot(root, destination)) {
    throw new Error(`Patch path escapes workspace: ${path}`);
  }

  const segments = path.split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Patch path traverses a symbolic link: ${path}`);
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw new Error(`Patch path parent is not a directory: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Patch path')) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
}

export async function validatePatchPaths(
  workspacePath: string,
  patch: string
): Promise<{ root: string; paths: string[] }> {
  if (patch.includes('GIT binary patch') || patch.includes('Binary files ')) {
    throw new Error('Binary patches are not supported');
  }

  const root = await realpath(workspacePath);
  const files = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (files.length === 0) throw new Error('No unified diff file headers were found');

  const paths = new Set<string>();
  for (const [, oldPath, newPath] of files) {
    for (const path of [oldPath, newPath]) {
      if (path === '/dev/null') continue;
      await assertSafePath(root, path);
      paths.add(path);
    }
  }
  return { root, paths: [...paths] };
}

const gitApply: GitApply = (workspace, patch, checkOnly) => {
  const result = spawnSync(
    'git',
    ['apply', ...(checkOnly ? ['--check'] : []), '--'],
    {
      cwd: workspace,
      encoding: 'utf8',
      input: patch,
      maxBuffer: 1_000_000,
      timeout: 10_000,
    }
  );
  if (result.error) throw new Error(`Could not validate patch with git: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail || `git apply failed with status ${result.status}`);
  }
};

export async function applyApprovedPatch(
  workspacePath: string,
  patch: string,
  confirm: (paths: string[], patch: string) => Promise<boolean>,
  runGitApply: GitApply = gitApply
): Promise<string[]> {
  const { root, paths } = await validatePatchPaths(workspacePath, patch);
  runGitApply(root, patch, true);
  if (!(await confirm(paths, patch))) throw new Error('Patch application was not approved');
  runGitApply(root, patch, false);
  return paths;
}
