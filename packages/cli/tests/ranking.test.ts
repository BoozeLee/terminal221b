import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  parseCaseBundle,
  parseCaseRecord,
  parseDuplicateSearchRecord,
  parseEvidenceRecord,
  parseSourceRecord,
  validateCaseBundle,
  type CaseBundle,
} from '../src/case.js';
// parseBountyScope lives in scope.js, not case.js. It was imported from case.js
// here, which does not re-export it, so it was `undefined` — and the one test
// that used it asserted only that calling it throws. A `TypeError: not a
// function` satisfies that, so the test passed while exercising nothing. See
// packages/cli/src/scope.ts:26 for the real export and
// packages/cli/tests/scope.test.ts:2 for the same import done correctly.
import { parseBountyScope } from '../src/scope.js';
import {
  FIXTURE_NOW,
  FIXTURE_POLICY_MAX_AGE_DAYS,
  fixtureBundle as unsignedFixtureBundle,
} from '../src/case-fixtures.js';
import { evaluateEligibility, rankCandidates } from '../src/ranking.js';
import { renderDossier } from '../src/dossier.js';
import {
  confirmationSignatureChecker,
  signBundle,
  type StoreManifest,
} from '../src/store.js';

const KEY_ID = 'ranking-test-key';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const manifest: StoreManifest = {
  version: 1,
  trustedKeys: [
    {
      keyId: KEY_ID,
      publicKeySpkiDerBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      addedAt: FIXTURE_NOW,
    },
  ],
};
// The eligibility gate is closed unless a caller hands it a trust decision, so
// the fixture is signed with a real in-process key and the checker is built from
// a real manifest. Nothing here is stubbed: an unsigned confirmation cannot
// reach `eligible` in this file, which is the whole point of F4.
const fixtureBundle = signBundle(unsignedFixtureBundle, privateKey, KEY_ID, FIXTURE_NOW);
const confirmationSigned = confirmationSignatureChecker(manifest);

const options = {
  now: FIXTURE_NOW,
  policyMaxAgeDays: FIXTURE_POLICY_MAX_AGE_DAYS,
  confirmationSigned,
};
const LEVEL_ORDER = { unknown: 0, low: 1, medium: 2, high: 3 } as const;

const caseIn = (caseId: string): CaseBundle['cases'][number] => {
  const item = fixtureBundle.cases.find((entry) => entry.caseId === caseId);
  if (!item) throw new Error(`fixture case ${caseId} is missing`);
  return item;
};

const eligibilityOf = (caseId: string) =>
  evaluateEligibility(caseIn(caseId), fixtureBundle, options);

/** The derived `asset` is never an input, so a re-parse must drop it. */
const rawBundle = (): Record<string, unknown> => {
  const json = JSON.parse(JSON.stringify(fixtureBundle)) as Record<string, unknown>;
  for (const item of json.cases as Record<string, unknown>[]) delete item.asset;
  return json;
};

const caseWith = (caseId: string, overrides: Record<string, unknown>) => {
  const item = caseIn(caseId) as unknown as Record<string, unknown>;
  const raw = { ...item };
  delete raw.asset;
  return parseCaseRecord({ ...raw, ...overrides });
};

const withCases = (cases: CaseBundle['cases'], sources: CaseBundle['sources'] = []): CaseBundle => ({
  ...fixtureBundle,
  cases,
  sources: sources.length > 0 ? sources : fixtureBundle.sources,
});

const candidateFor = (caseId: string, dropEvidence = false) => {
  const bundle = dropEvidence
    ? { ...fixtureBundle, evidence: fixtureBundle.evidence.filter((item) => item.caseId !== caseId) }
    : fixtureBundle;
  const [vector] = rankCandidates({ ...bundle, cases: [caseIn(caseId)] }, options);
  return vector;
};

describe('eligibility gate', () => {
  it('queues an exact in-scope asset that a human confirmed against the current snapshot', () => {
    const result = eligibilityOf('case-exact-in-scope');
    expect(result.eligibility).toBe('eligible');
    expect(result.reasons).toEqual([]);
    expect(result.reviewReasons).toEqual([]);
  });

  it('blocks an excluded subdomain', () => {
    const result = eligibilityOf('case-excluded-subdomain');
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toEqual(['asset_excluded']);
  });

  it('blocks a stale policy snapshot and reports its age', () => {
    const result = eligibilityOf('case-stale-policy');
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toEqual(['policy_stale']);
    expect(result.policyAgeDays).toBeGreaterThan(FIXTURE_POLICY_MAX_AGE_DAYS);
  });

  it('sends a lead with no deterministic evidence to review, not eligible', () => {
    const result = eligibilityOf('case-no-evidence');
    expect(result.eligibility).toBe('review');
    expect(result.reviewReasons).toContain('no_deterministic_evidence');
  });

  it('blocks a program with no scope manifest', () => {
    const result = evaluateEligibility(
      caseWith('case-exact-in-scope', { programId: 'unknown-program' }),
      fixtureBundle,
      options
    );
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toContain('scope_absent');
  });

  it('reports a missing snapshot as a missing snapshot, not a missing scope', () => {
    const result = evaluateEligibility(
      caseWith('case-exact-in-scope', { policySnapshotId: 'src-absent' }),
      fixtureBundle,
      options
    );
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toEqual(['policy_snapshot_missing']);
  });
});

describe('golden scenarios from the evaluation plan', () => {
  it('exact in scope: eligible', () => {
    expect(eligibilityOf('case-exact-in-scope').eligibility).toBe('eligible');
  });

  it('excluded subdomain: blocked', () => {
    expect(eligibilityOf('case-excluded-subdomain').eligibility).toBe('blocked');
  });

  it('stale policy: blocked', () => {
    expect(eligibilityOf('case-stale-policy').eligibility).toBe('blocked');
  });

  it('wildcard asset: held for review, never treated as an asset', () => {
    const result = eligibilityOf('case-wildcard-asset');
    expect(result.eligibility).toBe('review');
    expect(result.reviewReasons).toContain('asset_identity_wildcard');
    expect(caseIn('case-wildcard-asset').asset.status).toBe('wildcard');
  });

  it('similar but distinct asset: blocked, a near miss is not in scope', () => {
    expect(eligibilityOf('case-similar-asset').eligibility).toBe('blocked');
    expect(eligibilityOf('case-similar-asset').reasons).toEqual(['asset_excluded']);
  });

  it('no bounty for the asset type: blocked even though the asset is in scope', () => {
    const result = eligibilityOf('case-no-bounty-asset-type');
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toEqual(['no_bounty_for_asset_type']);
  });

  it('ambiguous asset normalization: held for review, never guessed at', () => {
    const result = eligibilityOf('case-ambiguous-asset');
    expect(result.eligibility).toBe('review');
    expect(result.reviewReasons).toContain('asset_identity_ambiguous');
    expect(caseIn('case-ambiguous-asset').asset.status).toBe('ambiguous');
  });

  it('duplicate lead: novelty is low, so it sorts below a clean lead', () => {
    const ranked = rankCandidates(fixtureBundle, options);
    const duplicate = ranked.find((item) => item.caseId === 'case-duplicate-lead');
    const clean = ranked.find((item) => item.caseId === 'case-exact-in-scope');
    expect(duplicate?.eligibility).toBe('eligible');
    expect(duplicate?.factors.novelty.level).toBe('low');
    expect(duplicate?.factors.novelty.refId).toBe('ds-duplicate-lead');
    expect(duplicate!.rank).toBeGreaterThan(clean!.rank);
  });

  it('no evidence lead: held for review', () => {
    expect(eligibilityOf('case-no-evidence').eligibility).toBe('review');
  });
});

describe('a case reaches the queue only through human confirmation', () => {
  it('holds an evidenced, in-scope, fresh lead when no human has confirmed it', () => {
    const result = eligibilityOf('case-unconfirmed');
    expect(result.eligibility).toBe('review');
    expect(result.reasons).toEqual([]);
    expect(result.reviewReasons).toEqual(['confirmation_absent']);
  });

  it('holds a confirmed lead whose confirmation nobody signed', () => {
    const result = evaluateEligibility(caseIn('case-exact-in-scope'), unsignedFixtureBundle, {
      now: FIXTURE_NOW,
      policyMaxAgeDays: FIXTURE_POLICY_MAX_AGE_DAYS,
    });
    expect(result.eligibility).toBe('review');
    expect(result.reasons).toEqual([]);
    expect(result.reviewReasons).toEqual(['confirmation_unsigned']);
  });

  it('holds the same lead when the caller supplies no trust decision at all', () => {
    // The default has to be the closed gate, or a bundle read straight off disk
    // outside a store would confer eligibility on its own assertion.
    const result = rankCandidates(unsignedFixtureBundle, {
      now: FIXTURE_NOW,
      policyMaxAgeDays: FIXTURE_POLICY_MAX_AGE_DAYS,
    }).find((item) => item.caseId === 'case-exact-in-scope');
    expect(result?.eligibility).toBe('review');
    expect(result?.reviewReasons).toEqual(['confirmation_unsigned']);
  });

  it('holds a lead whose confirmation was signed by a key the store does not trust', () => {
    const other = generateKeyPairSync('ed25519');
    const strangerManifest: StoreManifest = {
      version: 1,
      trustedKeys: [
        {
          keyId: 'someone-elses-key',
          publicKeySpkiDerBase64: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          addedAt: FIXTURE_NOW,
        },
      ],
    };
    const result = evaluateEligibility(caseIn('case-exact-in-scope'), fixtureBundle, {
      now: FIXTURE_NOW,
      policyMaxAgeDays: FIXTURE_POLICY_MAX_AGE_DAYS,
      confirmationSigned: confirmationSignatureChecker(strangerManifest),
    });
    expect(result.eligibility).toBe('review');
    expect(result.reviewReasons).toEqual(['confirmation_unsigned']);
  });

  it('holds a lead confirmed against a snapshot the case no longer uses', () => {
    const result = eligibilityOf('case-stale-confirmation');
    expect(result.eligibility).toBe('review');
    expect(result.reasons).toEqual([]);
    expect(result.reviewReasons).toEqual(['confirmation_mismatch']);
  });

  it('rejects a confirmation pinned to a different asset as unusable', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      confirmations: [
        {
          version: 1,
          confirmationId: 'cf-transplanted',
          caseId: 'case-exact-in-scope',
          confirmedBy: 'human',
          confirmedAt: '2026-09-29T09:30:00Z',
          policySnapshotId: 'src-policy-current',
          asset: 'https://example.invalid/programs/checkout-service/rate-limit',
          statement: 'Confirmed a different asset than the case records',
        },
      ],
    });
    const [vector] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(vector.eligibility).toBe('review');
    expect(vector.reviewReasons).toEqual(['confirmation_mismatch']);
    expect(validateCaseBundle(bundle)).toEqual([]);
  });

  it('holds a case whose program has no captured material', () => {
    const bundle = { ...fixtureBundle, programs: [] };
    const [vector] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(vector.eligibility).toBe('review');
    expect(vector.reviewReasons).toContain('program_record_absent');
  });
});

describe('ranking', () => {
  it('queues only eligible cases and numbers them from one', () => {
    const ranked = rankCandidates(fixtureBundle, options);
    const eligible = ranked.filter((item) => item.eligibility === 'eligible');
    expect(eligible.map((item) => item.caseId)).toEqual([
      'case-exact-in-scope',
      'case-duplicate-lead',
    ]);
    expect(eligible[0].rank).toBe(0);
    expect(ranked.filter((item) => item.eligibility !== 'eligible').every((item) => item.rank === -1)).toBe(true);
  });

  it('leaves a factor unknown when no record and no assessment supports it', () => {
    const [top] = rankCandidates(fixtureBundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.reward_fit.level).toBe('unknown');
  });

  it('takes a factor from a cited assessment, and says where it came from', () => {
    const [top] = rankCandidates(fixtureBundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.impact_fit.level).toBe('medium');
    expect(top.factors.impact_fit.refId).toBe('example-inhouse-program');
    expect(top.factors.effort.level).toBe('low');
  });

  it('links each derived factor to a record', () => {
    const [top] = rankCandidates(fixtureBundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.evidence_quality.refId).toBe('ev-repro-cache-header');
    expect(top.factors.freshness.refId).toBe('src-policy-current');
  });

  it('says the freshness timestamp is operator-recorded', () => {
    const [top] = rankCandidates(fixtureBundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.freshness.basis).toContain('operator-recorded, not corroborated');
  });

  it('does not reorder a case when unrelated metadata changes', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      cases: (rawBundle().cases as Record<string, unknown>[]).map((item) =>
        item.caseId === 'case-exact-in-scope' ? { ...item, state: 'awaiting_owner' } : item
      ),
    });
    const before = rankCandidates(fixtureBundle, options).map((item) => item.caseId);
    const after = rankCandidates(bundle, options).map((item) => item.caseId);
    expect(after).toEqual(before);
  });

  it('never lets a weaker factor outrank a stronger one', () => {
    const current = fixtureBundle.sources.find((item) => item.sourceId === 'src-policy-current')!;
    const downgraded = rankCandidates(
      withCases(fixtureBundle.cases, [
        ...fixtureBundle.sources.filter((item) => item.sourceId !== 'src-policy-current'),
        parseSourceRecord({ ...current, observedAt: '2026-09-01T00:00:00Z' }),
      ]),
      { ...options, policyMaxAgeDays: 3 }
    );
    const [top] = downgraded;
    expect(top.eligibility).toBe('blocked');
    expect(top.factors.freshness.level).toBe('low');
  });
});

describe('an assessment can lower a level but never raise one', () => {
  it('keeps the derived level and says the assessment was not applied', () => {
    const [top] = rankCandidates(fixtureBundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.novelty.level).toBe('medium');
    expect(top.assessmentNotes.join(' ')).toContain('as-exact-novelty');
    expect(top.assessmentNotes.join(' ')).toContain('the derived level was kept');
  });

  it('refuses to resolve two assessments for the same factor', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      assessments: [
        ...(rawBundle().assessments as Record<string, unknown>[]),
        {
          version: 1,
          assessmentId: 'as-exact-impact-second',
          caseId: 'case-exact-in-scope',
          factor: 'impact_fit',
          level: 'low',
          basis: 'A second, conflicting reading of the same rubric',
          refId: 'example-inhouse-program',
          assessedBy: 'human',
          assessedAt: '2026-09-29T10:45:00Z',
        },
      ],
    });
    const [top] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(top.factors.impact_fit.level).toBe('unknown');
    expect(top.assessmentNotes.join(' ')).toContain('a conflict is not a judgement');
  });

  it('requires an impact or reward assessment to cite the program it was read from', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      assessments: [
        {
          version: 1,
          assessmentId: 'as-uncited',
          caseId: 'case-exact-in-scope',
          factor: 'impact_fit',
          level: 'high',
          basis: 'Asserted without a citable program',
          refId: 'src-scanner-output',
          assessedBy: 'human',
          assessedAt: '2026-09-29T10:50:00Z',
        },
      ],
    });
    expect(validateCaseBundle(bundle).join(' ')).toContain('must cite a program record');
  });

  it('requires a novelty assessment to cite a duplicate search for the same case', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      assessments: [
        {
          version: 1,
          assessmentId: 'as-wrong-search',
          caseId: 'case-exact-in-scope',
          factor: 'novelty',
          level: 'high',
          basis: 'Cites another case search',
          refId: 'ds-duplicate-lead',
          assessedBy: 'human',
          assessedAt: '2026-09-29T10:55:00Z',
        },
      ],
    });
    expect(validateCaseBundle(bundle).join(' ')).toContain('belongs to case case-duplicate-lead');
  });

  it('refuses a duplicate search record that claims an agent ran it', () => {
    expect(() =>
      parseDuplicateSearchRecord({
        version: 1,
        searchId: 'ds-bad',
        caseId: 'case-exact-in-scope',
        searchedAt: FIXTURE_NOW,
        surfaceCovered: 'nowhere',
        similarityCaveat: 'none',
        matchedCaseIds: [],
        performedBy: 'agent',
      })
    ).toThrow('performedBy must be human');
  });
});

describe('claim status is never inferred from verification alone', () => {
  const withHypothesisVerified = (evidenceId: string): CaseBundle => ({
    ...fixtureBundle,
    evidence: fixtureBundle.evidence.map((item) =>
      item.evidenceId === evidenceId
        ? parseEvidenceRecord({ ...item, verification: 'deterministic' })
        : item
    ),
  });

  it('keeps a hypothesis-only case out of the actionable queue', () => {
    const bundle = withHypothesisVerified('ev-unverified-lead');
    const [vector] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-no-evidence'
    );
    expect(vector.eligibility).toBe('review');
    expect(vector.factors.evidence_quality.level).toBe('low');
    expect(vector.factors.reproducibility.level).toBe('unknown');
  });

  it('prefers a confirmed fact over a verified hypothesis on the same case', () => {
    const bundle = withHypothesisVerified('ev-scanner-hypothesis');
    const [vector] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-exact-in-scope'
    );
    expect(vector.eligibility).toBe('eligible');
    expect(vector.factors.evidence_quality.level).toBe('high');
    expect(vector.factors.evidence_quality.refId).toBe('ev-repro-cache-header');
  });

  it('reports a missing manifest and a missing snapshot as two distinct facts', () => {
    const result = evaluateEligibility(
      caseWith('case-exact-in-scope', { programId: 'unknown-program', policySnapshotId: 'src-absent' }),
      fixtureBundle,
      options
    );
    expect(result.eligibility).toBe('blocked');
    expect(result.reasons).toEqual(['scope_absent', 'policy_snapshot_missing']);
  });
});

describe('property invariants', () => {
  const labels = (bundle: CaseBundle) =>
    new Map(rankCandidates(bundle, options).map((item) => [item.caseId, item.eligibility]));
  const SEVERITY = ['eligible', 'review', 'blocked'];

  it('adding an exclusion never increases eligibility', () => {
    const before = labels(fixtureBundle);
    const after = labels(
      parseCaseBundle({
        ...rawBundle(),
        scope: fixtureBundle.scope.map((item) => ({
          ...item,
          outOfScope: [
            ...(item.outOfScope ?? []),
            'https://example.invalid/programs/checkout-service/legacy',
          ],
        })),
      })
    );
    for (const id of before.keys()) {
      expect(SEVERITY.indexOf(after.get(id)!)).toBeGreaterThanOrEqual(
        SEVERITY.indexOf(before.get(id)!)
      );
    }
  });

  it('removing scope cannot make a candidate eligible', () => {
    const ranked = rankCandidates(parseCaseBundle({ ...rawBundle(), scope: [] }), options);
    expect(ranked.every((item) => item.eligibility === 'blocked')).toBe(true);
  });

  it('unknown evidence cannot improve a factor', () => {
    const withUnknown = candidateFor('case-no-evidence');
    const withoutEvidence = candidateFor('case-no-evidence', true);
    expect(withoutEvidence.factors.evidence_quality.level).toBe('unknown');
    expect(LEVEL_ORDER[withoutEvidence.factors.evidence_quality.level]).toBeLessThanOrEqual(
      LEVEL_ORDER[withUnknown.factors.evidence_quality.level]
    );
  });

  it('a confirmation for a different snapshot never confers eligibility', () => {
    const bundle = parseCaseBundle({
      ...rawBundle(),
      confirmations: [
        {
          version: 1,
          confirmationId: 'cf-wrong-snapshot',
          caseId: 'case-unconfirmed',
          confirmedBy: 'human',
          confirmedAt: '2026-09-29T09:30:00Z',
          policySnapshotId: 'src-policy-stale',
          asset: 'https://example.invalid/programs/checkout-service/rate-limit',
          statement: 'Confirmed against the wrong snapshot',
        },
      ],
    });
    const [vector] = rankCandidates(bundle, options).filter(
      (item) => item.caseId === 'case-unconfirmed'
    );
    expect(vector.eligibility).toBe('review');
    expect(vector.reviewReasons).toEqual(['confirmation_mismatch']);
  });

  it('removing a published bounty asset type never increases eligibility', () => {
    const before = labels(fixtureBundle);
    const after = labels(
      parseCaseBundle({
        ...rawBundle(),
        programs: fixtureBundle.programs.map((item) => ({
          ...item,
          bountyAssetTypes: item.bountyAssetTypes.filter((type) => type !== 'web-application'),
        })),
      })
    );
    for (const id of before.keys()) {
      expect(SEVERITY.indexOf(after.get(id)!)).toBeGreaterThanOrEqual(
        SEVERITY.indexOf(before.get(id)!)
      );
    }
    expect(after.get('case-exact-in-scope')).toBe('blocked');
  });

  it('asset normalization never turns a non-match into a match', () => {
    const wildcards = ['https://example.invalid/*', '*', 'https://example.invalid/programs/checkout-?'];
    for (const original of wildcards) {
      const item = caseWith('case-exact-in-scope', { assetOriginal: original });
      expect(item.asset.status).not.toBe('exact');
      expect(evaluateEligibility(item, fixtureBundle, options).eligibility).toBe('review');
    }
  });

  it('asset normalization never widens a scope exclusion', () => {
    const item = caseWith('case-excluded-subdomain', {
      assetOriginal: 'https://example.invalid/programs/checkout-service/vendor-portal/console',
    });
    expect(evaluateEligibility(item, fixtureBundle, options).reasons).toContain('asset_excluded');
  });
});

describe('dossier rendering', () => {
  const text = renderDossier(fixtureBundle, options);

  it('renders every case with an eligibility label', () => {
    for (const item of fixtureBundle.cases) {
      expect(text).toContain(`### ${item.caseId}`);
    }
    expect(text).toContain('### case-exact-in-scope — ELIGIBLE');
    expect(text).toContain('### case-stale-policy — BLOCKED');
  });

  it('explains why a case is held for review', () => {
    expect(text).toContain('awaiting operator: confirmation_absent');
    expect(text).toContain('awaiting operator: asset_identity_wildcard');
  });

  it('shows no unresolved provenance problems for the fixture bundle', () => {
    expect(validateCaseBundle(fixtureBundle)).toEqual([]);
    expect(text).toContain('All records link');
  });

  it('surfaces a broken link instead of hiding it', () => {
    const broken = {
      ...fixtureBundle,
      evidence: fixtureBundle.evidence.map((item) =>
        item.evidenceId === 'ev-scope-match' ? { ...item, sourceId: 'src-gone' } : item
      ),
    };
    expect(renderDossier(broken, options)).toContain('sourceId src-gone has no source record');
  });

  it('strips control characters and line breaks out of untrusted bundle text', () => {
    const hostile = {
      ...fixtureBundle,
      cases: fixtureBundle.cases.map((item) =>
        item.caseId === 'case-no-evidence'
          ? { ...item, objective: 'safe[31mred\n## Injected heading' }
          : item
      ),
    };
    const rendered = renderDossier(hostile, options);
    expect(rendered).not.toContain('\u001b');
    expect(rendered).toContain('## Cases');
    expect(
      rendered.split('\n').some((line) => line.startsWith('## Injected'))
    ).toBe(false);
    expect(rendered).toContain('safe\ufffd[31mred ## Injected heading');
  });

  it('escapes a pipe so untrusted text cannot forge a table row', () => {
    const hostile = {
      ...fixtureBundle,
      assessments: fixtureBundle.assessments.map((item) =>
        item.assessmentId === 'as-exact-impact'
          ? { ...item, basis: 'medium | high | critical' }
          : item
      ),
    };
    const rendered = renderDossier(hostile, options);
    const rows = rendered.split('\n').filter((entry) => entry.startsWith('|'));
    expect(rows.some((row) => row.includes('medium \\| high'))).toBe(true);
    for (const row of rows) {
      expect(row.split(/(?<!\\)\|/).length).toBe(6);
    }
  });

  it('reports an assessment it refused to apply', () => {
    expect(text).toContain('Assessments not applied:');
  });

  it('quotes program material as published and never as a number', () => {
    expect(text).toContain('Quoted from the 2026-09 snapshot');
    expect(text).toContain('does not estimate reward size, payout odds, or an overall score');
  });

  it('states what it does not do', () => {
    expect(text).toContain('does not contact a target');
    expect(text).toContain('does not verify a policy snapshot');
  });

  it('shows the freshness limit it was evaluated with', () => {
    expect(text).toContain(`policy freshness limit of ${FIXTURE_POLICY_MAX_AGE_DAYS} days`);
  });
});

describe('a case that cannot be evaluated is reported, not dropped', () => {
  it('keeps the rest of the dossier intact', () => {
    const broken = {
      ...fixtureBundle,
      scope: [
        {
          ...fixtureBundle.scope[0],
          inScope: [],
        },
      ],
    };
    const ranked = rankCandidates(broken, options);
    expect(ranked.length).toBe(fixtureBundle.cases.length);
  });
});

describe('scope interaction', () => {
  it('reuses the existing scope manifest validator', () => {
    expect(() =>
      parseBountyScope({ version: 1, program: 'p', policyUrl: 'http://insecure.test', inScope: [] })
    ).toThrow();
  });
});
