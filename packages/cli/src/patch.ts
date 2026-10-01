import { realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { assertSafePath } from './path-guard.js';

export type GitApply = (
  workspace: string,
  patch: string,
  checkOnly: boolean
) => void;

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
