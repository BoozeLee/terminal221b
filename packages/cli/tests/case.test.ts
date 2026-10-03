import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCaseBundle,
  parseApprovalRecord,
  parseAssessmentRecord,
  parseCaseRecord,
  parseConfirmationRecord,
  parseDuplicateSearchRecord,
  parseEvidenceRecord,
  parseOutcomeRecord,
  parseProgramRecord,
  parseSourceRecord,
  parseTaskContract,
  validateCaseBundle,
  type CaseBundle,
} from '../src/case.js';
import { fixtureBundle } from '../src/case-fixtures.js';
import { canonicalAsset, normalizeAsset, parseBountyScope } from '../src/scope.js';

/**
 * Scratch directories created by this file, removed when the suite ends.
 *
 * They are tracked rather than removed inline because the tests assert on
 * paths INSIDE them, so a directory has to survive the `it` that created it and
 * die after the `describe` that needed it. A leak here is invisible per test
 * run and cumulative across them, which is how a TypeScript fixture leak ended
 * up filling the tmpfs and failing eight unrelated Rust tests with
 * `Disk quota exceeded`. See docs/TERMINAL221B-GATES.md section 20.
 */
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sourceJson = {
  version: 1,
  sourceId: 'src-1',
  uri: 'file://notes/a.md',
  kind: 'fixture',
  observedAt: '2026-09-29T08:00:00Z',
  contentDigest: 'sha256:'.concat('c'.repeat(64)),
  retention: 'case_metadata',
};

const caseJson = {
  version: 1,
  caseId: 'case-1',
  objective: 'Confirm the asset is in scope',
  programId: 'example-inhouse-program',
  assetOriginal: 'https://example.invalid/programs/checkout-service',
  assetType: 'web-application',
  policySnapshotId: 'src-policy',
  createdAt: '2026-09-29T08:00:00Z',
  state: 'intake',
};

const evidenceJson = {
  version: 1,
  evidenceId: 'ev-1',
  caseId: 'case-1',
  claim: 'The snapshot lists the asset as in scope',
  claimType: 'fact',
  sourceId: 'src-1',
  observedAt: '2026-09-29T08:00:00Z',
  confidenceReason: 'Deterministic match against the snapshot digest',
  verification: 'deterministic',
};

const taskJson = {
  version: 1,
  taskId: 'task-1',
  caseId: 'case-1',
  role: 'scout',
  goal: 'Resolve the asset against the recorded snapshot',
  readRefs: ['ev-1'],
  writablePaths: [],
  capability: 'observe',
  acceptanceChecks: ['No request leaves the local machine'],
  provenanceRequired: true,
  outputSchemaVersion: 1,
};

const approvalJson = {
  version: 1,
  approvalId: 'ap-1',
  caseId: 'case-1',
  taskId: 'task-1',
  effect: 'apply the proposed diff to a local scratch copy',
  payloadDigest: 'sha256:'.concat('d'.repeat(64)),
  decision: 'approved',
  decidedBy: 'human',
  decidedAt: '2026-09-29T09:00:00Z',
};

const outcomeJson = {
  version: 1,
  outcomeId: 'out-1',
  caseId: 'case-1',
  disposition: 'submitted_by_owner',
  recordedBy: 'human',
  recordedAt: '2026-09-30T09:00:00Z',
};

const confirmationJson = {
  version: 1,
  confirmationId: 'cf-1',
  caseId: 'case-1',
  confirmedBy: 'human',
  confirmedAt: '2026-09-29T09:00:00Z',
  policySnapshotId: 'src-policy',
  asset: 'https://example.invalid/programs/checkout-service',
  statement: 'Read the snapshot and confirmed this exact asset',
};

const programJson = {
  version: 1,
  programId: 'example-inhouse-program',
  displayName: 'Example in-house program',
  policySnapshotId: 'src-policy',
  bountyAssetTypes: ['web-application'],
  rewardSchedulePublished: 'Quoted from the snapshot: "USD 500 to USD 2500 per accepted report".',
  rewardCategoriesPublished: ['low', 'medium', 'high'],
  reportRequirements: ['Include a reproducible request and response pair'],
  testingConstraints: ['No denial-of-service testing'],
  capturedAt: '2026-09-29T08:30:00Z',
};

const searchJson = {
  version: 1,
  searchId: 'ds-1',
  caseId: 'case-1',
  searchedAt: '2026-09-29T09:15:00Z',
  surfaceCovered: 'example.invalid duplicate index',
  similarityCaveat: 'An empty result is not proof that no duplicate exists',
  matchedCaseIds: [],
  performedBy: 'human',
};

const assessmentJson = {
  version: 1,
  assessmentId: 'as-1',
  caseId: 'case-1',
  factor: 'impact_fit',
  level: 'medium',
  basis: 'Operator mapped this to the published medium category',
  refId: 'example-inhouse-program',
  assessedBy: 'human',
  assessedAt: '2026-09-29T09:20:00Z',
};

describe('case contracts', () => {
  it('accepts a well-formed case record', () => {
    expect(parseCaseRecord(caseJson).caseId).toBe('case-1');
  });

  it('rejects a non-object case record', () => {
    expect(() => parseCaseRecord('case-1')).toThrow('Case record must be a JSON object');
  });

  it('rejects an unknown schema version', () => {
    expect(() => parseCaseRecord({ ...caseJson, version: 2 })).toThrow(
      'Case record version must be 1'
    );
  });

  it('rejects an unknown field instead of dropping it', () => {
    expect(() => parseCaseRecord({ ...caseJson, payout: 5000 })).toThrow(
      'Case record has an unknown field payout'
    );
  });

  it('rejects a blank required string', () => {
    expect(() => parseCaseRecord({ ...caseJson, objective: '   ' })).toThrow(
      'objective must be a non-empty string'
    );
  });

  it('rejects a non-UTC timestamp', () => {
    expect(() => parseCaseRecord({ ...caseJson, createdAt: '2026-09-29' })).toThrow(
      'createdAt must be an ISO-8601 UTC timestamp'
    );
  });

  it('rejects a non-list state', () => {
    expect(() => parseCaseRecord({ ...caseJson, state: 'exploited' })).toThrow(
      'state must be one of'
    );
  });

  it('requires a retention class on every source', () => {
    expect(() => parseSourceRecord({ ...sourceJson, retention: undefined })).toThrow(
      'retention must be one of'
    );
  });

  it('requires a content digest shaped like sha256', () => {
    expect(() => parseSourceRecord({ ...sourceJson, contentDigest: 'sha256:zz' })).toThrow(
      'contentDigest must be a sha256:'
    );
  });

  it('rejects a fact claim that is still unverified', () => {
    expect(() => parseEvidenceRecord({ ...evidenceJson, verification: 'unverified' })).toThrow(
      'a fact claim requires verification of deterministic or operator_confirmed'
    );
  });

  it('allows an unverified hypothesis', () => {
    const parsed = parseEvidenceRecord({
      ...evidenceJson,
      claimType: 'hypothesis',
      verification: 'unverified',
    });
    expect(parsed.verification).toBe('unverified');
  });

  it('rejects the sign/transfer capability outright', () => {
    expect(() =>
      parseTaskContract({ ...taskJson, capability: 'sign_transfer', writablePaths: [] })
    ).toThrow('capability sign_transfer is not in the MVP');
  });

  it('rejects write scope below the modify capability', () => {
    expect(() =>
      parseTaskContract({ ...taskJson, capability: 'analyze', writablePaths: ['patches/a.diff'] })
    ).toThrow('writablePaths require the modify or submit_publish capability, not analyze');
  });

  it('keeps write scope when the capability allows it', () => {
    const parsed = parseTaskContract({
      ...taskJson,
      capability: 'modify',
      writablePaths: ['patches/a.diff'],
    });
    expect(parsed.writablePaths).toEqual(['patches/a.diff']);
  });

  it('rejects a non-boolean provenance flag', () => {
    expect(() => parseTaskContract({ ...taskJson, provenanceRequired: 'yes' })).toThrow(
      'provenanceRequired must be true or false'
    );
  });

  it('rejects an agent-recorded approval', () => {
    expect(() => parseApprovalRecord({ ...approvalJson, decidedBy: 'agent' })).toThrow(
      'decidedBy must be human'
    );
  });

  it('rejects a paid outcome with no receipt', () => {
    expect(() => parseOutcomeRecord({ ...outcomeJson, disposition: 'paid' })).toThrow(
      'a paid outcome requires a receiptReference; a published reward is not payment'
    );
  });

  it('accepts a paid outcome with a receipt and a labelled cost', () => {
    const parsed = parseOutcomeRecord({
      ...outcomeJson,
      disposition: 'paid',
      receiptReference: 'file://receipts/a.txt',
      actualCostUsd: { amount: 0.75, source: 'provider_reported' },
    });
    expect(parsed.actualCostUsd?.source).toBe('provider_reported');
  });

  it('rejects an unlabelled cost', () => {
    expect(() =>
      parseOutcomeRecord({
        ...outcomeJson,
        receiptReference: 'file://receipts/a.txt',
        actualCostUsd: { amount: 0.75, source: 'guess' },
      })
    ).toThrow('actualCostUsd.source must be one of');
  });
});

describe('the records a decision depends on', () => {
  it('rejects a confirmation an agent claims to have made', () => {
    expect(() => parseConfirmationRecord({ ...confirmationJson, confirmedBy: 'agent' })).toThrow(
      'confirmedBy must be human'
    );
  });

  it('rejects a confirmation of a wildcard, which confirms nothing', () => {
    expect(() =>
      parseConfirmationRecord({ ...confirmationJson, asset: 'https://example.invalid/*' })
    ).toThrow('a wildcard or ambiguous value confirms nothing');
  });

  it('accepts a confirmation of one exact asset', () => {
    expect(parseConfirmationRecord(confirmationJson).asset).toBe(
      'https://example.invalid/programs/checkout-service'
    );
  });

  it('keeps a published reward schedule as text, never as a number', () => {
    const parsed = parseProgramRecord(programJson);
    expect(typeof parsed.rewardSchedulePublished).toBe('string');
    expect(parsed.rewardSchedulePublished).toContain('Quoted from the snapshot');
  });

  it('rejects a duplicate search with no similarity caveat', () => {
    expect(() => parseDuplicateSearchRecord({ ...searchJson, similarityCaveat: '' })).toThrow(
      'similarityCaveat must be a non-empty string'
    );
  });

  it('rejects a duplicate search with no surface named', () => {
    expect(() => parseDuplicateSearchRecord({ ...searchJson, surfaceCovered: '' })).toThrow(
      'surfaceCovered must be a non-empty string'
    );
  });

  it('rejects an assessment that asserts nothing', () => {
    expect(() => parseAssessmentRecord({ ...assessmentJson, level: 'unknown' })).toThrow(
      'level may not be unknown'
    );
  });

  it('rejects an assessment of a factor the bundle already derives', () => {
    expect(() => parseAssessmentRecord({ ...assessmentJson, factor: 'freshness' })).toThrow(
      'factor must be one of'
    );
  });

  it('requires an impact or reward assessment to cite a program record', () => {
    const bundle: CaseBundle = {
      ...validBundle,
      assessments: [parseAssessmentRecord({ ...assessmentJson, refId: 'src-1' })],
    };
    expect(validateCaseBundle(bundle)).toContain(
      'assessment as-1: factor impact_fit must cite a program record, and refId src-1 is not one'
    );
  });

  it('requires a novelty assessment to cite a duplicate search for the same case', () => {
    const bundle: CaseBundle = {
      ...validBundle,
      duplicateSearches: [parseDuplicateSearchRecord({ ...searchJson, caseId: 'case-2' })],
      assessments: [
        parseAssessmentRecord({ ...assessmentJson, factor: 'novelty', refId: 'ds-1' }),
      ],
    };
    expect(validateCaseBundle(bundle).join(' ')).toContain('belongs to case case-2');
  });

  it('requires an effort assessment to cite something it was read from', () => {
    const bundle: CaseBundle = {
      ...validBundle,
      assessments: [parseAssessmentRecord({ ...assessmentJson, factor: 'effort', refId: 'ev-nope' })],
    };
    expect(validateCaseBundle(bundle)).toContain(
      'assessment as-1: refId ev-nope resolves to no record in the bundle'
    );
  });

  it('accepts an effort assessment that cites the evidence behind it', () => {
    const bundle: CaseBundle = {
      ...validBundle,
      assessments: [parseAssessmentRecord({ ...assessmentJson, factor: 'effort', refId: 'ev-1' })],
    };
    expect(validateCaseBundle(bundle)).toEqual([]);
  });

  it('flags two snapshots that share a version string but differ in content', () => {
    const bundle: CaseBundle = {
      ...validBundle,
      sources: [
        parseSourceRecord({
          ...sourceJson,
          sourceId: 'src-policy',
          kind: 'policy_snapshot',
          policyVersion: '2026-09',
        }),
        parseSourceRecord({
          ...sourceJson,
          sourceId: 'src-policy-edited',
          kind: 'policy_snapshot',
          policyVersion: '2026-09',
          contentDigest: 'sha256:'.concat('e'.repeat(64)),
        }),
      ],
    };
    expect(validateCaseBundle(bundle).join(' ')).toContain(
      'share policyVersion 2026-09 but differ in content'
    );
  });
});

describe('asset identity is reduced, never guessed', () => {
  it('reduces one exact https asset to a canonical form', () => {
    expect(normalizeAsset('https://Example.invalid/programs/checkout-service/')).toEqual({
      status: 'exact',
      canonical: 'https://example.invalid/programs/checkout-service',
    });
  });

  it('never reduces a wildcard to an asset', () => {
    for (const pattern of ['*', 'https://example.invalid/*', 'https://example.invalid/a/*']) {
      expect(normalizeAsset(pattern).status).toBe('wildcard');
    }
  });

  it('refuses a value that is not an absolute url', () => {
    const identity = normalizeAsset('programs/checkout-service');
    expect(identity.status).toBe('ambiguous');
    expect(identity).toMatchObject({ reason: 'asset is not an absolute URL' });
  });

  it('refuses a value that is not https', () => {
    expect(normalizeAsset('http://example.invalid/programs/a')).toMatchObject({
      status: 'ambiguous',
      reason: 'asset is not https',
    });
  });

  it('refuses a value carrying credentials, a query, or a fragment', () => {
    expect(normalizeAsset('https://user:pw@example.invalid/a/b').status).toBe('ambiguous');
    expect(normalizeAsset('https://example.invalid/a/b?ref=1').status).toBe('ambiguous');
    expect(normalizeAsset('https://example.invalid/a/b#x').status).toBe('ambiguous');
  });

  it('refuses a host it cannot tell apart from an internal one', () => {
    expect(normalizeAsset('https://intranet/programs/a')).toMatchObject({
      status: 'ambiguous',
      reason: 'asset host is not fully qualified',
    });
  });

  it('refuses a value that names no specific asset', () => {
    expect(normalizeAsset('https://example.invalid/').status).toBe('ambiguous');
  });

  it('yields no canonical asset for anything but an exact identity', () => {
    expect(canonicalAsset(normalizeAsset('https://example.invalid/*'))).toBeUndefined();
    expect(canonicalAsset(normalizeAsset('http://example.invalid/a/b'))).toBeUndefined();
    expect(canonicalAsset(normalizeAsset('https://example.invalid/a/b'))).toBe(
      'https://example.invalid/a/b'
    );
  });
});

const validBundle: CaseBundle = {
  version: 1,
  scope: [
    parseBountyScope({
      version: 1,
      program: 'example-inhouse-program',
      policyUrl: 'https://example.invalid/policies/example-inhouse-program',
      inScope: ['https://example.invalid/programs/checkout-service'],
    }),
  ],
  cases: [parseCaseRecord(caseJson)],
  sources: [
    parseSourceRecord({ ...sourceJson, sourceId: 'src-policy', kind: 'policy_snapshot' }),
    parseSourceRecord(sourceJson),
  ],
  programs: [parseProgramRecord(programJson)],
  evidence: [parseEvidenceRecord(evidenceJson)],
  tasks: [parseTaskContract(taskJson)],
  approvals: [parseApprovalRecord(approvalJson)],
  confirmations: [parseConfirmationRecord(confirmationJson)],
  duplicateSearches: [],
  assessments: [],
  outcomes: [parseOutcomeRecord(outcomeJson)],
};

describe('case bundle provenance', () => {
  it('reports no problems for a fully linked bundle', () => {
    expect(validateCaseBundle(validBundle)).toEqual([]);
  });

  it('rejects an evidence record with no source', () => {
    const bundle = {
      ...validBundle,
      evidence: [parseEvidenceRecord({ ...evidenceJson, sourceId: 'src-missing' })],
    };
    expect(validateCaseBundle(bundle)).toContain(
      'evidence ev-1: sourceId src-missing has no source record'
    );
  });

  it('rejects a case whose policy snapshot is not a policy snapshot', () => {
    const bundle = {
      ...validBundle,
      sources: [parseSourceRecord({ ...sourceJson, sourceId: 'src-policy' })],
    };
    expect(validateCaseBundle(bundle)).toContain(
      'case case-1: policySnapshotId src-policy is a fixture source, not a policy_snapshot'
    );
  });

  it('rejects a case whose program has no scope manifest', () => {
    const bundle = { ...validBundle, cases: [parseCaseRecord({ ...caseJson, programId: 'other' })] };
    expect(validateCaseBundle(bundle)).toContain(
      'case case-1: programId other has no scope manifest'
    );
  });

  it('rejects a task readRef that resolves to nothing', () => {
    const bundle = {
      ...validBundle,
      tasks: [parseTaskContract({ ...taskJson, readRefs: ['ev-missing'] })],
    };
    expect(validateCaseBundle(bundle)).toContain(
      'task task-1: readRef ev-missing resolves to no evidence or source record'
    );
  });

  it('rejects an approval with no task', () => {
    const bundle = { ...validBundle, tasks: [], approvals: [parseApprovalRecord(approvalJson)] };
    expect(validateCaseBundle(bundle)).toContain(
      'approval ap-1: taskId task-1 is not in the bundle'
    );
  });

  it('rejects a duplicate record id', () => {
    const bundle = { ...validBundle, cases: [parseCaseRecord(caseJson), parseCaseRecord(caseJson)] };
    expect(validateCaseBundle(bundle)).toContain('duplicate record id case-1');
  });
});

describe('fixture dataset', () => {
  it('parses and links cleanly', () => {
    expect(validateCaseBundle(fixtureBundle)).toEqual([]);
  });

  it('covers the golden evaluation cases without any live target', () => {
    const assets = fixtureBundle.cases.map((item) => canonicalAsset(item.asset));
    expect(assets.some((asset) => asset?.includes('vendor-portal'))).toBe(true);
    expect(fixtureBundle.sources.every((item) => item.uri.includes('example.invalid') || item.uri.startsWith('file://') || item.uri.startsWith('local://'))).toBe(true);
    expect(fixtureBundle.evidence.some((item) => item.verification === 'unverified')).toBe(true);
  });
});

describe('reading a bundle from disk names each way it can fail', () => {
  // Guide 7.4 item 3 asks a surface to design its failure states, and "the
  // source is missing" is one of the three it names. It arrived as a raw
  // node:fs ENOENT, so the dossier screen had nothing designed to show. These
  // assert the designed text, and the control asserts the three failures are
  // genuinely distinct rather than one message reused.
  const dir = mkdtempSync(join(tmpdir(), 'terminal221b-load-'));
  // Removed when this describe block finishes. The suite asserts on paths
  // inside it, so it has to outlive the individual `it`s — but not the process.
  scratchDirs.push(dir);

  it('says a missing bundle does not exist, in plain words', async () => {
    const missing = join(dir, 'not-here.json');
    await expect(loadCaseBundle(missing)).rejects.toThrow(/does not exist/);
    await expect(loadCaseBundle(missing)).rejects.toThrow(/No case bundle at/);
    // The raw Node error is the thing this replaced. If ENOENT text comes back,
    // the fix has been undone.
    await expect(loadCaseBundle(missing)).rejects.not.toThrow(/ENOENT/);
  });

  it('names the path it looked at, so the operator knows which file', async () => {
    const missing = join(dir, 'named.json');
    await expect(loadCaseBundle(missing)).rejects.toThrow(missing);
  });

  it('says a directory is not a bundle', async () => {
    await expect(loadCaseBundle(dir)).rejects.toThrow(/is a directory, not a case bundle/);
  });

  it('says malformed JSON is malformed JSON', async () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    await expect(loadCaseBundle(broken)).rejects.toThrow(/Invalid case bundle JSON/);
  });

  it('the control: the three failures read as three different mistakes', async () => {
    const missing = await loadCaseBundle(join(dir, 'gone.json')).catch((e) => e.message as string);
    const brokenPath = join(dir, 'also-broken.json');
    writeFileSync(brokenPath, 'nope');
    const broken = await loadCaseBundle(brokenPath).catch((e) => e.message as string);
    const dirError = await loadCaseBundle(dir).catch((e) => e.message as string);
    const distinct = new Set([missing, broken, dirError]);
    expect(distinct.size).toBe(3);
  });

  it('the control: a real bundle still loads', async () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(fixtureBundle));
    const loaded = await loadCaseBundle(good);
    expect(loaded.cases.length).toBe(fixtureBundle.cases.length);
  });
});
