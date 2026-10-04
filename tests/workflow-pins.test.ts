import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every third-party GitHub Action is pinned to a commit sha, and the pin names
 * its release.
 *
 * A `uses:` reference is mutable unless it is a commit sha. `actions/checkout@v7`
 * resolves to whatever `v7` points at today, so a workflow naming a tag is a
 * workflow whose behaviour can change without a commit — in the middle of the
 * job that decides whether this repository is worth merging. This repository
 * deploys nothing yet, so today the exposure is a build step; the day it does,
 * it is the deploy.
 *
 * Two rules, because pinning without naming the release is half a pin. A sha
 * says exactly which commit ran, but not which release it belongs to, so the
 * tag goes in a trailing comment. Without it, upgrading means replacing forty hex
 * characters with nothing to confirm the replacement against, and a sha copied
 * from the wrong repository's release notes is indistinguishable from a correct
 * one.
 *
 * A moving branch is named with its date instead: `dtolnay/rust-toolchain@stable`
 * is a branch, not a release, and has no version number to record. `# stable@2026-10-01`
 * says which branch tip was taken and when, which is the same guarantee a tag
 * would give.
 *
 * The workflow list is discovered, never written out. A check that names the
 * manifests it inspects does not notice one added later.
 */
const WORKFLOW_DIR = join(process.cwd(), '.github', 'workflows');
const SHA = /^[0-9a-f]{40}$/;
/** A release tag (`# v7`, `# v9.1.2`) or a moving branch with its date. */
const NAMED = /^(v\d[\w.-]*|[A-Za-z][\w-]*@\d{4}-\d{2}-\d{2})$/;

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(WORKFLOW_DIR, f));
}

/**
 * One `uses:` line, with its trailing comment.
 *
 * A line-walk rather than a YAML parse, on purpose: the repository has no YAML
 * dependency and adding one to a supply-chain check would be the wrong trade. The
 * control below is what makes the regex trustworthy in exchange — it plants a
 * known-bad line and asserts the extractor sees it.
 */
function parseUses(line: string): { ref: string; comment: string } | null {
  const m = /uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(line.trim());
  if (!m) return null;
  return { ref: m[1], comment: (m[2] ?? '').trim() };
}

function isLocal(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('../');
}

describe('GitHub Actions are pinned to a commit sha that names its release', () => {
  it('finds the workflow files at all', () => {
    // Without this, a moved directory makes every rule below pass vacuously,
    // which is the failure this whole file exists to prevent.
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it('pins every third-party action, and names the release', () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of workflowFiles()) {
      const rel = file.replace(`${process.cwd()}/`, '');
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const uses = parseUses(line);
        if (!uses || isLocal(uses.ref)) continue;
        checked++;
        const [name, ref] = uses.ref.split('@');
        if (!ref || !SHA.test(ref)) {
          offenders.push(`${rel}: ${name} is pinned to "${ref ?? 'nothing'}", not a 40-character sha`);
        } else if (!NAMED.test(uses.comment)) {
          offenders.push(
            `${rel}: ${name}@${ref.slice(0, 7)} is pinned but does not name its release ` +
              `(comment is "${uses.comment}"); a sha alone says which commit ran, not which release it is`,
          );
        }
      }
    }

    expect(checked, 'no third-party actions found — the rule is passing vacuously').toBeGreaterThan(0);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the extractor sees a planted unpinned line, so the rule above is not vacuous', () => {
    // A control for the control. If `parseUses` silently returned null for the
    // shapes it is meant to catch, the rule above would report zero offenders
    // and pass — which is exactly the "green that verified nothing" this
    // repository has been removing all along.
    expect(parseUses('      - uses: actions/checkout@v7')?.ref).toBe('actions/checkout@v7');
    expect(parseUses('      - uses: actions/checkout@v7 # v7')?.ref).toBe('actions/checkout@v7');
    expect(parseUses('      - uses: actions/checkout@v7 # v7')?.comment).toBe('v7');
    expect(parseUses('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7')?.ref)
      .toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');

    // These must NOT be reported, or the rule fires on things it should not.
    expect(parseUses('      - name: build')).toBeNull();
    expect(parseUses('      - run: npm ci')).toBeNull();
    expect(isLocal('./.github/actions/local')).toBe(true);

    // And the sha/naming predicates, on the exact shapes that decide the verdict.
    expect(SHA.test('v7')).toBe(false);
    expect(SHA.test('3d3c42e5aac5ba805825da76410c181273ba90b1')).toBe(true);
    expect(NAMED.test('v7')).toBe(true);
    expect(NAMED.test('stable@2026-10-01')).toBe(true);
    expect(NAMED.test('')).toBe(false);
    expect(NAMED.test('latest')).toBe(false);
  });
});
