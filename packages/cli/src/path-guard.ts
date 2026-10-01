import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * One ruleset for every path a case is allowed to name, shared by the patch
 * executor and by the contract parser.
 *
 * Two tiers exist because they answer different questions and the callers sit
 * in different worlds. `assertSafePath` is async and asks the filesystem what
 * is actually there, so it is only usable from a code path that can wait. The
 * declarative tier is pure string analysis and is the only kind available
 * inside a synchronous parse, so a contract that names a traversal is rejected
 * at parse time rather than trusted until something executes it.
 */

export function withinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..');
}

export function isSensitivePath(path: string): boolean {
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

/**
 * The whole purely lexical half of the ruleset: empty, quoted, backslashed,
 * sensitive, absolute, or walking through `..` or `.git`.
 *
 * Once absolute paths and `..` segments are both refused, `resolve` cannot
 * place the result outside the root, so `withinRoot` can never contradict this
 * function. It is kept as a separate tier anyway so the two checks stay
 * independently true rather than one being an argument for the other.
 */
export function isDisallowedPathString(path: string): boolean {
  return (
    !path ||
    path.includes('"') ||
    path.includes('\\') ||
    isSensitivePath(path) ||
    isAbsolute(path) ||
    path.split('/').some((part) => part === '..' || part === '.git')
  );
}

/**
 * Parse-time guard for a declared writable path. Synchronous on purpose: a
 * contract that fails to parse is never produced, so a bad path cannot reach a
 * later stage that would have to remember to check it again.
 *
 * This cannot see the filesystem, so a symlinked parent directory inside the
 * workspace still parses. That is the documented limit of the tier, and it is
 * why the async tier is not replaced by this one.
 */
export function assertDeclarablePath(path: string, field: string): void {
  if (isDisallowedPathString(path)) {
    throw new Error(`${field} declares a disallowed path: ${path}`);
  }
}

export async function assertSafePath(root: string, path: string): Promise<void> {
  if (isDisallowedPathString(path)) {
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
