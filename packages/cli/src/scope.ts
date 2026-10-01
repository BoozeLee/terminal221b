import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface BountyScopeManifest {
  version: 1;
  program: string;
  policyUrl: string;
  inScope: string[];
  outOfScope?: string[];
}

function parseTarget(value: string, field: string): URL {
  if (value.includes('*')) throw new Error(`${field} must not contain wildcards`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must be HTTPS without credentials, query, or fragment`);
  }
  return url;
}

export function parseBountyScope(input: unknown): BountyScopeManifest {
  if (!input || typeof input !== 'object') throw new Error('Scope manifest must be a JSON object');
  const value = input as Record<string, unknown>;
  if (value.version !== 1) throw new Error('Scope manifest version must be 1');
  if (typeof value.program !== 'string' || !value.program.trim()) {
    throw new Error('Scope manifest needs a program name');
  }
  if (typeof value.policyUrl !== 'string') throw new Error('Scope manifest needs a policy URL');
  parseTarget(value.policyUrl, 'policyUrl');
  if (!Array.isArray(value.inScope) || value.inScope.length === 0) {
    throw new Error('Scope manifest needs at least one in-scope HTTPS URL');
  }
  if (!value.inScope.every((item) => typeof item === 'string')) {
    throw new Error('inScope entries must be URLs');
  }
  if (value.outOfScope !== undefined && !Array.isArray(value.outOfScope)) {
    throw new Error('outOfScope must be an array of URLs');
  }

  const inScope = value.inScope.map((target) => {
    const url = parseTarget(target, 'inScope entry');
    return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '/');
  });
  const outOfScope = (value.outOfScope as unknown[] | undefined)?.map((target) => {
    if (typeof target !== 'string') throw new Error('outOfScope entries must be URLs');
    return parseTarget(target, 'outOfScope entry').toString();
  });

  return {
    version: 1,
    program: value.program.trim(),
    policyUrl: parseTarget(value.policyUrl, 'policyUrl').toString(),
    inScope,
    ...(outOfScope ? { outOfScope } : {}),
  };
}

/**
 * An asset identity is either exact (one canonical HTTPS asset), a wildcard
 * (the intake source named a pattern, which must never become canonical), or
 * ambiguous (the value cannot be reduced to one exact asset without a
 * judgement). Only an exact identity may be tested against a scope manifest, so
 * a wildcard or ambiguous asset cannot reach the scope gate by accident.
 */
export type AssetIdentity =
  | { status: 'exact'; canonical: string }
  | { status: 'wildcard'; pattern: string }
  | { status: 'ambiguous'; reason: string };

/**
 * Only `*` is read as a glob marker. A `?` or `#` is rejected before the URL is
 * parsed, because the URL parser silently drops a trailing `?` and would then
 * hand back a shorter asset than the operator wrote. Dropping a character to make
 * a value fit is exactly what this function must never do.
 */
const WILDCARD = /\*/;

/**
 * Normalizes an asset exactly as reported. Deliberately narrow: it never widens
 * to a prefix, never drops a query, fragment, or credential to make a value fit,
 * and never guesses a TLD. Anything it cannot reduce to one exact HTTPS asset
 * comes back for an operator to resolve.
 */
export function normalizeAsset(original: string): AssetIdentity {
  if (WILDCARD.test(original)) {
    return { status: 'wildcard', pattern: original };
  }
  if (original.includes('?')) {
    return { status: 'ambiguous', reason: 'asset carries a query, which may select a different asset' };
  }
  if (original.includes('#')) {
    return { status: 'ambiguous', reason: 'asset carries a fragment' };
  }
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return { status: 'ambiguous', reason: 'asset is not an absolute URL' };
  }
  if (url.protocol !== 'https:') {
    return { status: 'ambiguous', reason: 'asset is not https' };
  }
  if (url.username || url.password) {
    return { status: 'ambiguous', reason: 'asset carries credentials' };
  }
  if (url.search) {
    return { status: 'ambiguous', reason: 'asset carries a query, which may select a different asset' };
  }
  if (url.hash) {
    return { status: 'ambiguous', reason: 'asset carries a fragment' };
  }
  if (!url.hostname.includes('.')) {
    return { status: 'ambiguous', reason: 'asset host is not fully qualified' };
  }
  if (url.pathname === '' || url.pathname === '/') {
    return { status: 'ambiguous', reason: 'asset names no specific program or repository' };
  }
  return { status: 'exact', canonical: `https://${url.host}${url.pathname}`.replace(/\/+$/, '') };
}

/** The exact canonical asset, or undefined when the identity is not exact. */
export function canonicalAsset(identity: AssetIdentity): string | undefined {
  return identity.status === 'exact' ? identity.canonical : undefined;
}

function pathMatches(scopePath: string, targetPath: string): boolean {
  const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  return targetPath === scopePath || targetPath.startsWith(prefix);
}

export function isTargetInScope(
  rawTarget: string,
  manifest: BountyScopeManifest
): boolean {
  const target = parseTarget(rawTarget, 'target');
  const matches = (scopeValue: string): boolean => {
    const scope = parseTarget(scopeValue, 'scope entry');
    return scope.origin === target.origin && pathMatches(scope.pathname, target.pathname);
  };
  if (manifest.outOfScope?.some(matches)) return false;
  return manifest.inScope.some(matches);
}

export async function loadBountyScope(path: string): Promise<BountyScopeManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid scope JSON: ${error.message}`);
    throw error;
  }
  return parseBountyScope(parsed);
}
