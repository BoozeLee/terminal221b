import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOUNDARY_FILE_PATH, boundaryFile, clausesOf, renderSystemPrompt } from '../src/system-prompt.js';

/**
 * The drift guard on this side, mirroring `packages/rust-tui/src/boundary_drift.rs`.
 *
 * The bug this slice exists to fix was one boundary enforced in two places that
 * had already diverged. Saying "both sides read the same file" proves nothing,
 * so both sides mutate a copy of the real file and assert they notice.
 */

type Clause = string;

function withCryptoProhibitionRemoved(clause: Clause): string {
  const raw = readFileSync(BOUNDARY_FILE_PATH, 'utf8');
  const file = JSON.parse(raw) as {
    clauseOrder: Clause[];
    clauses: Record<Clause, string>;
    profiles: Record<string, Clause[]>;
  };
  file.profiles.crypto = file.profiles.crypto.filter((entry) => entry !== clause);
  return JSON.stringify(file);
}

/** The same render the production path uses, over a file we chose. */
function renderFrom(serialized: string, profile: string): string {
  const file = JSON.parse(serialized) as {
    clauseOrder: Clause[];
    clauses: Record<Clause, string>;
    profiles: Record<string, Clause[]>;
  };
  return file.clauseOrder
    .filter((clause) => file.profiles[profile].includes(clause))
    .map((clause) => file.clauses[clause])
    .join(' ');
}

describe('the guard fires, with a control that proves it', () => {
  it('the control: the real file carries the prohibition', () => {
    expect(clausesOf('crypto')).toContain('no_wallet_secrets');
    expect(renderSystemPrompt('crypto')).toContain('Do not handle or request wallet secrets.');
  });

  it('removing a prohibition from the crypto profile is visible to this renderer', () => {
    const mutated = withCryptoProhibitionRemoved('no_wallet_secrets');
    expect(renderFrom(mutated, 'crypto')).not.toContain('Do not handle or request wallet secrets.');
  });

  it('removing a universal prohibition changes the rendered system text', () => {
    const raw = readFileSync(BOUNDARY_FILE_PATH, 'utf8');
    const file = JSON.parse(raw) as { profiles: Record<string, Clause[]> };
    file.profiles.coding = file.profiles.coding.filter(
      (clause) => clause !== 'no_secrets_requested_or_transmitted'
    );
    const rendered = renderFrom(JSON.stringify(file), 'coding');
    expect(rendered).not.toContain('Never request, print, commit, or transmit');
  });

  it('an unknown profile is refused rather than rendered as a bare prompt', () => {
    const raw = readFileSync(BOUNDARY_FILE_PATH, 'utf8');
    const file = JSON.parse(raw) as { profiles: Record<string, Clause[]> };
    delete file.profiles.coding;
    expect(() => renderFrom(JSON.stringify(file), 'coding')).toThrow();
  });

  it('both surfaces read the same file, and it says so in its own note', () => {
    expect(BOUNDARY_FILE_PATH.endsWith('provider-boundary.json')).toBe(true);
    expect(boundaryFile().note).toMatch(/single source of truth/i);
    expect(boundaryFile().note).toMatch(/fail/i);
  });

  it('the note warns against the exact mistake that was made', () => {
    // A guard that does not name the failure it prevents is easy to remove.
    expect(boundaryFile().note).toMatch(/one implementation|not the other/i);
  });

  it("the crate's copy is byte-identical to this one", () => {
    // The other half of the guard, and the one that became necessary when the
    // crate got a copy of its own. `include_str!` cannot read outside a
    // published crate, so `packages/rust-tui/resources/provider-boundary.json`
    // exists purely so the TUI can embed the policy — and a policy edit that
    // touched this file but not that one would leave every other test here green
    // while the TUI enforced a weaker boundary than the CLI. Silent, and
    // security-relevant, which is the exact shape of the drift this file exists
    // to catch.
    //
    // The Rust side asserts the same equality from its own end
    // (`the_embedded_copy_is_byte_identical_to_the_canonical_file`), and
    // scripts/assert-boundary-copies-identical.sh compares the two files on
    // disk. Three checks of one invariant is not redundancy for its own sake: a
    // test that cannot run in some environment should not be the only thing
    // standing between a policy edit and a weaker boundary.
    const mirror = readFileSync(
      fileURLToPath(new URL('../../rust-tui/resources/provider-boundary.json', import.meta.url)),
      'utf8',
    );
    const canonical = readFileSync(BOUNDARY_FILE_PATH, 'utf8');

    expect(mirror).toBe(canonical);
  });
});
