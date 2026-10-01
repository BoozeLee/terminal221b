import { canonicalAsset, isTargetInScope, type BountyScopeManifest } from './scope.js';
import { RANK_FACTORS, RANK_LEVELS } from './case.js';
import type {
  AssessmentRecord,
  CaseBundle,
  CaseRecord,
  ClaimType,
  ConfirmationRecord,
  EvidenceRecord,
  SourceRecord,
  Verification,
} from './case.js';

/**
 * Eligibility gate and evidence-linked ordinal ranking. There is no weighted
 * score and no payout estimate here on purpose: an expected-value number would
 * be a claim the bundle cannot support. Factors that the bundle does not
 * determine stay `unknown`, and `unknown` never outranks a known level.
 */

export { RANK_FACTORS, RANK_LEVELS };

export type RankFactor = (typeof RANK_FACTORS)[number];
export type RankLevel = (typeof RANK_LEVELS)[number];

/**
 * `not_evaluated` is not a fourth verdict. It is what a case gets when
 * evaluation itself failed, so one unusable case cannot be reported as blocked
 * for a reason nobody can act on, and cannot silently disappear either.
 */
export type Eligibility = 'blocked' | 'review' | 'eligible' | 'not_evaluated';

export type BlockReason =
  | 'scope_absent'
  | 'asset_excluded'
  | 'policy_snapshot_missing'
  | 'policy_stale'
  | 'no_bounty_for_asset_type'
  /** Reserved: nothing in this slice can emit it. It is first reachable in Phase 6. */
  | 'authorization_unknown';

/** Why a case is held for the operator. A review is a queue, not a verdict. */
export type ReviewReason =
  | 'asset_identity_wildcard'
  | 'asset_identity_ambiguous'
  | 'program_record_absent'
  | 'confirmation_absent'
  | 'confirmation_mismatch'
  /** The matching confirmation exists but nobody with the key signed it. */
  | 'confirmation_unsigned'
  | 'no_deterministic_evidence';

export interface EvaluationOptions {
  now: string;
  policyMaxAgeDays: number;
  /**
   * Whether a confirmation carries a signature that verifies against a key the
   * store trusts. Omitted means false, deliberately: a bundle read straight off
   * disk outside a store has no key set, so it must not be able to confer
   * eligibility. The gate is closed by default, because the only way to open it
   * is to hand the evaluator a trust decision that was made somewhere else.
   */
  confirmationSigned?: (confirmation: ConfirmationRecord) => boolean;
}

export interface EligibilityResult {
  caseId: string;
  eligibility: Eligibility;
  reasons: BlockReason[];
  reviewReasons: ReviewReason[];
  policySnapshotId: string;
  policyAgeDays: number | null;
  policyMaxAgeDays: number;
}

export interface FactorValue {
  level: RankLevel;
  basis: string;
  refId?: string;
}

export interface CandidateVector {
  caseId: string;
  eligibility: Eligibility;
  reasons: BlockReason[];
  reviewReasons: ReviewReason[];
  factors: Record<RankFactor, FactorValue>;
  /** Assessments that were not applied, and why. Nothing is dropped in silence. */
  assessmentNotes: string[];
  /** Set when evaluation itself failed, so the failure is visible. */
  notEvaluatedReason?: string;
  rank: number;
}

const MS_PER_DAY = 86_400_000;

const LEVEL_RANK: Record<RankLevel, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const VERIFICATION_RANK: Record<Verification, number> = {
  unverified: 0,
  operator_confirmed: 1,
  deterministic: 2,
};

const CLAIM_TYPE_RANK: Record<ClaimType, number> = {
  hypothesis: 0,
  fact: 1,
};

const UNDETERMINED: FactorValue = {
  level: 'unknown',
  basis: 'not derivable from the bundle; needs operator or program input',
};

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

function scopeFor(bundle: CaseBundle, programId: string): BountyScopeManifest | undefined {
  return bundle.scope.find((item) => item.program === programId);
}

function sourceById(bundle: CaseBundle, sourceId: string): SourceRecord | undefined {
  return bundle.sources.find((item) => item.sourceId === sourceId);
}

function evidenceFor(bundle: CaseBundle, caseId: string): EvidenceRecord[] {
  return bundle.evidence.filter((item) => item.caseId === caseId);
}

function confirmationsFor(bundle: CaseBundle, caseId: string) {
  return bundle.confirmations.filter((item) => item.caseId === caseId);
}

function searchesFor(bundle: CaseBundle, caseId: string) {
  return bundle.duplicateSearches.filter((item) => item.caseId === caseId);
}

function assessmentsFor(bundle: CaseBundle, caseId: string): AssessmentRecord[] {
  return bundle.assessments.filter((item) => item.caseId === caseId);
}

/**
 * A verified hypothesis is still a hypothesis, so a fact always outranks one no
 * matter how the hypothesis was verified.
 */
function bestEvidence(evidence: EvidenceRecord[]): EvidenceRecord | undefined {
  return [...evidence].sort(
    (left, right) =>
      CLAIM_TYPE_RANK[right.claimType] - CLAIM_TYPE_RANK[left.claimType] ||
      VERIFICATION_RANK[right.verification] - VERIFICATION_RANK[left.verification] ||
      left.evidenceId.localeCompare(right.evidenceId)
  )[0];
}

/**
 * The gate decides three things, in order: is the asset inside a policy we hold,
 * is that policy fresh, and has a human confirmed this exact asset against this
 * exact snapshot. Only all three together put a case in the actionable queue.
 * Anything short of that is either blocked (a fact the operator must change) or
 * review (a decision the operator must make).
 */
export function evaluateEligibility(
  item: CaseRecord,
  bundle: CaseBundle,
  options: EvaluationOptions
): EligibilityResult {
  const reasons: BlockReason[] = [];
  const reviewReasons: ReviewReason[] = [];

  const scope = scopeFor(bundle, item.programId);
  if (!scope) reasons.push('scope_absent');

  const asset = canonicalAsset(item.asset);
  if (!asset) {
    reviewReasons.push(
      item.asset.status === 'wildcard' ? 'asset_identity_wildcard' : 'asset_identity_ambiguous'
    );
  } else if (scope && !isTargetInScope(asset, scope)) {
    reasons.push('asset_excluded');
  }

  const snapshot = sourceById(bundle, item.policySnapshotId);
  const policyAgeDays = snapshot ? daysBetween(snapshot.observedAt, options.now) : null;
  if (!snapshot) reasons.push('policy_snapshot_missing');
  else if (policyAgeDays !== null && policyAgeDays > options.policyMaxAgeDays) {
    reasons.push('policy_stale');
  }

  const program = bundle.programs.find((entry) => entry.programId === item.programId);
  if (!program) {
    reviewReasons.push('program_record_absent');
  } else if (!program.bountyAssetTypes.includes(item.assetType)) {
    reasons.push('no_bounty_for_asset_type');
  }

  const confirmed = evidenceFor(bundle, item.caseId).some(
    (claim) => claim.claimType === 'fact' && claim.verification === 'deterministic'
  );
  if (!confirmed) reviewReasons.push('no_deterministic_evidence');

  const confirmations = confirmationsFor(bundle, item.caseId);
  if (confirmations.length === 0) {
    reviewReasons.push('confirmation_absent');
  } else {
    const matching = confirmations.filter(
      (entry) => entry.asset === asset && entry.policySnapshotId === item.policySnapshotId
    );
    if (matching.length === 0) {
      reviewReasons.push('confirmation_mismatch');
    } else if (!matching.some((entry) => (options.confirmationSigned ?? (() => false))(entry))) {
      // A confirmation the bundle merely asserts. Only a signature from a key
      // the store trusts turns the assertion into a decision.
      reviewReasons.push('confirmation_unsigned');
    }
  }

  const blocked = reasons.length > 0;
  const eligibility: Eligibility = blocked
    ? 'blocked'
    : reviewReasons.length === 0
      ? 'eligible'
      : 'review';

  return {
    caseId: item.caseId,
    eligibility,
    reasons: [...new Set(reasons)],
    reviewReasons: [...new Set(reviewReasons)],
    policySnapshotId: item.policySnapshotId,
    policyAgeDays,
    policyMaxAgeDays: options.policyMaxAgeDays,
  };
}

/**
 * Freshness is measured from an operator-recorded observedAt, not from anything
 * this code can corroborate, so every basis says so. A stale policy is low, and
 * freshness is a visible gate rather than a term in the ordering.
 */
function factorFreshness(result: EligibilityResult, snapshot: SourceRecord | undefined): FactorValue {
  if (!snapshot || result.policyAgeDays === null) {
    return { level: 'unknown', basis: 'no policy snapshot is linked to this case' };
  }
  const age = `policy snapshot is ${result.policyAgeDays} days old against a ${result.policyMaxAgeDays} day limit; observedAt is operator-recorded, not corroborated`;
  if (result.policyAgeDays > result.policyMaxAgeDays) {
    return { level: 'low', basis: age, refId: snapshot.sourceId };
  }
  return { level: 'high', basis: age, refId: snapshot.sourceId };
}

/**
 * Novelty is derived from a recorded duplicate search, never from silence. A
 * search that found nothing is medium, not high: a search cannot prove absence.
 */
function factorNovelty(bundle: CaseBundle, caseId: string): FactorValue {
  const searches = searchesFor(bundle, caseId);
  if (searches.length === 0) {
    return { level: 'unknown', basis: 'no duplicate search is recorded for this case' };
  }
  const withMatches = searches.filter((item) => item.matchedCaseIds.length > 0);
  if (withMatches.length > 0) {
    const matched = [...new Set(withMatches.flatMap((item) => item.matchedCaseIds))].sort();
    return {
      level: 'low',
      basis: `a recorded duplicate search matched ${matched.join(', ')}`,
      refId: withMatches[0].searchId,
    };
  }
  const search = [...searches].sort((left, right) => left.searchId.localeCompare(right.searchId))[0];
  return {
    level: 'medium',
    basis: `a duplicate search covered ${search.surfaceCovered} and matched nothing; similarity remains a lead, not proof`,
    refId: search.searchId,
  };
}

function factorEvidenceQuality(best: EvidenceRecord | undefined): FactorValue {
  if (!best) {
    return { level: 'unknown', basis: 'no evidence is recorded for this case' };
  }
  if (best.claimType === 'hypothesis') {
    return {
      level: 'low',
      basis: 'the strongest claim is still a hypothesis, however it was verified',
      refId: best.evidenceId,
    };
  }
  return {
    level:
      best.verification === 'deterministic'
        ? 'high'
        : best.verification === 'operator_confirmed'
          ? 'medium'
          : 'low',
    basis: `strongest claim is a fact with ${best.verification}`,
    refId: best.evidenceId,
  };
}

function factorReproducibility(
  evidence: EvidenceRecord[],
  bundle: CaseBundle
): FactorValue {
  const artifact = evidence.find((claim) => {
    if (claim.claimType !== 'fact' || claim.verification !== 'deterministic') return false;
    return sourceById(bundle, claim.sourceId)?.kind !== 'policy_snapshot';
  });
  if (artifact) {
    return {
      level: 'medium',
      basis: 'a deterministic claim is backed by a non-policy artifact',
      refId: artifact.evidenceId,
    };
  }
  return {
    level: 'unknown',
    basis: 'no deterministic claim is backed by a reproducible artifact',
  };
}

/**
 * An operator assessment may state a level for a factor the bundle cannot
 * derive, and may lower a derived one. It may never raise a derived level, and
 * two assessments for the same factor are treated as a conflict rather than
 * silently resolved. Every rejection is returned as a note so the operator can
 * see that their input was not used, and why.
 */
function applyAssessments(
  derived: Record<RankFactor, FactorValue>,
  bundle: CaseBundle,
  caseId: string
): { factors: Record<RankFactor, FactorValue>; notes: string[] } {
  const notes: string[] = [];
  const factors = { ...derived };
  const byFactor = new Map<RankFactor, AssessmentRecord[]>();
  for (const record of assessmentsFor(bundle, caseId)) {
    byFactor.set(record.factor, [...(byFactor.get(record.factor) ?? []), record]);
  }
  for (const [factor, records] of byFactor) {
    if (records.length > 1) {
      const ids = records.map((item) => item.assessmentId).sort().join(', ');
      notes.push(`${factor}: ${ids} all state a level; none was applied, because a conflict is not a judgement`);
      continue;
    }
    const record = records[0];
    const current = factors[factor].level;
    if (current !== 'unknown' && LEVEL_RANK[record.level] > LEVEL_RANK[current]) {
      notes.push(
        `${factor}: assessment ${record.assessmentId} claims ${record.level} but the bundle already derives ${current}; the derived level was kept`
      );
      continue;
    }
    factors[factor] = { level: record.level, basis: record.basis, refId: record.refId };
  }
  return { factors, notes };
}

export function evaluateCandidate(
  item: CaseRecord,
  bundle: CaseBundle,
  options: EvaluationOptions
): CandidateVector {
  const result = evaluateEligibility(item, bundle, options);
  const evidence = evidenceFor(bundle, item.caseId);
  const best = bestEvidence(evidence);
  const snapshot = sourceById(bundle, item.policySnapshotId);
  const { factors, notes } = applyAssessments(
    {
      impact_fit: UNDETERMINED,
      evidence_quality: factorEvidenceQuality(best),
      reproducibility: factorReproducibility(evidence, bundle),
      novelty: factorNovelty(bundle, item.caseId),
      effort: UNDETERMINED,
      reward_fit: UNDETERMINED,
      freshness: factorFreshness(result, snapshot),
    },
    bundle,
    item.caseId
  );
  return {
    caseId: item.caseId,
    eligibility: result.eligibility,
    reasons: result.reasons,
    reviewReasons: result.reviewReasons,
    factors,
    assessmentNotes: notes,
    rank: -1,
  };
}

const ORDER: readonly RankFactor[] = [
  'impact_fit',
  'evidence_quality',
  'reproducibility',
  'novelty',
  'effort',
];

const LOWER_IS_BETTER: ReadonlySet<RankFactor> = new Set<RankFactor>(['effort']);

/** Blocked cases are the ones an operator must resolve before anything else. */
const ORDER_BY_SEVERITY: Record<Eligibility, number> = {
  blocked: 0,
  review: 1,
  not_evaluated: 2,
  eligible: 3,
};

function compareFactors(left: CandidateVector, right: CandidateVector): number {
  for (const factor of ORDER) {
    const delta = LEVEL_RANK[right.factors[factor].level] - LEVEL_RANK[left.factors[factor].level];
    if (delta !== 0) return LOWER_IS_BETTER.has(factor) ? -delta : delta;
  }
  return left.caseId.localeCompare(right.caseId);
}

function notEvaluated(caseId: string, reason: string): CandidateVector {
  const factors = Object.fromEntries(
    RANK_FACTORS.map((factor) => [factor, UNDETERMINED])
  ) as Record<RankFactor, FactorValue>;
  return {
    caseId,
    eligibility: 'not_evaluated',
    reasons: [],
    reviewReasons: [],
    factors,
    assessmentNotes: [],
    notEvaluatedReason: reason,
    rank: -1,
  };
}

/**
 * One unusable case must not cost the operator the rest of the dossier, so a
 * case that throws while being evaluated is marked and reported rather than
 * allowed to abort the run. The asset identity is discriminated, so this is a
 * backstop rather than the expected path.
 */
export function rankCandidates(
  bundle: CaseBundle,
  options: EvaluationOptions
): CandidateVector[] {
  const candidates = bundle.cases.map((item) => {
    try {
      return evaluateCandidate(item, bundle, options);
    } catch (error) {
      return notEvaluated(item.caseId, error instanceof Error ? error.message : String(error));
    }
  });
  const actionable = candidates
    .filter((item) => item.eligibility === 'eligible')
    .sort(compareFactors);
  const rest = candidates
    .filter((item) => item.eligibility !== 'eligible')
    .sort((left, right) => {
      if (left.eligibility !== right.eligibility) {
        return ORDER_BY_SEVERITY[left.eligibility] - ORDER_BY_SEVERITY[right.eligibility];
      }
      return left.caseId.localeCompare(right.caseId);
    });
  return [...actionable, ...rest].map((item, index) => ({
    ...item,
    rank: item.eligibility === 'eligible' ? index : -1,
  }));
}
