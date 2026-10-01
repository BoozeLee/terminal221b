import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  normalizeAsset,
  parseBountyScope,
  type AssetIdentity,
  type BountyScopeManifest,
} from './scope.js';
import { assertDeclarablePath } from './path-guard.js';

/**
 * Phase 0 case contracts. Every parser is fail-closed: an unrecognised value
 * is an error, never a default. These types are the versioned data contract a
 * later runtime (adapter, TUI, or offline prototype) can be held to, so the
 * validators encode the boundaries rather than trusting the caller.
 */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

const CASE_STATES = ['intake', 'research', 'awaiting_owner', 'closed'] as const;
const SOURCE_KINDS = [
  'policy_snapshot',
  'local_file',
  'fixture',
  'scanner_output',
  'operator_note',
] as const;
const RETENTION_CLASSES = [
  'transient',
  'case_metadata',
  'local_diff',
  'operator_archive',
] as const;
const CLAIM_TYPES = ['fact', 'hypothesis'] as const;
const VERIFICATIONS = ['deterministic', 'operator_confirmed', 'unverified'] as const;
const AGENT_ROLES = ['scout', 'analyst', 'engineer', 'artist', 'reviewer'] as const;
const CAPABILITIES = [
  'observe',
  'research',
  'analyze',
  'draft',
  'modify',
  'submit_publish',
] as const;
const WRITE_CAPABILITIES: readonly Capability[] = ['modify', 'submit_publish'];
const APPROVAL_DECISIONS = ['approved', 'rejected', 'deferred'] as const;
const DISPOSITIONS = [
  'ready_for_owner_review',
  'submitted_by_owner',
  'accepted',
  'duplicate',
  'rejected',
  'paid',
  'abandoned',
] as const;
const COST_SOURCES = ['provider_reported', 'invoice', 'operator_estimate'] as const;

/**
 * The ordinal factors live with the contracts, not in the ranking module, so a
 * record that states a level (an operator assessment) can be validated against
 * the same vocabulary the ranking module orders by. ranking.ts re-exports them.
 */
const RANK_FACTORS = [
  'impact_fit',
  'evidence_quality',
  'reproducibility',
  'novelty',
  'effort',
  'reward_fit',
  'freshness',
] as const;
const RANK_LEVELS = ['unknown', 'low', 'medium', 'high'] as const;

/**
 * The factors an operator assessment may state. Every one of these is `unknown`
 * unless a record in the bundle supports it, which is exactly when a human
 * judgement is the only remaining input. A factor that becomes derivable must be
 * removed from this list, so an assessment can never raise a derived level.
 */
const ASSESSABLE_FACTORS = ['impact_fit', 'novelty', 'effort', 'reward_fit'] as const;

/** Factors whose level an assessment must justify by citing a program record. */
const CITES_PROGRAM: readonly RankFactor[] = ['impact_fit', 'reward_fit'];

export { RANK_FACTORS, RANK_LEVELS, ASSESSABLE_FACTORS };

export type CaseState = (typeof CASE_STATES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type RetentionClass = (typeof RETENTION_CLASSES)[number];
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type Verification = (typeof VERIFICATIONS)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type CaseDisposition = (typeof DISPOSITIONS)[number];
export type CostSource = (typeof COST_SOURCES)[number];
export type RankFactor = (typeof RANK_FACTORS)[number];
export type RankLevel = (typeof RANK_LEVELS)[number];
export type AssessableFactor = (typeof ASSESSABLE_FACTORS)[number];

export interface CaseRecord {
  version: 1;
  caseId: string;
  objective: string;
  programId: string;
  /** The asset exactly as the intake source reported it, ambiguity and all. */
  assetOriginal: string;
  /** normalizeAsset(assetOriginal). Only an exact identity can pass the scope gate. */
  asset: AssetIdentity;
  /** The class of asset, compared against the program's published bounty asset types. */
  assetType: string;
  policySnapshotId: string;
  createdAt: string;
  state: CaseState;
}

export interface SourceRecord {
  version: 1;
  sourceId: string;
  uri: string;
  owner?: string;
  kind: SourceKind;
  observedAt: string;
  policyVersion?: string;
  contentDigest: string;
  retention: RetentionClass;
}

export interface EvidenceRecord {
  version: 1;
  evidenceId: string;
  caseId: string;
  claim: string;
  claimType: ClaimType;
  sourceId: string;
  observedAt: string;
  confidenceReason: string;
  verification: Verification;
}

export interface TaskContract {
  version: 1;
  taskId: string;
  caseId: string;
  role: AgentRole;
  goal: string;
  workspaceRef?: string;
  readRefs: string[];
  writablePaths: string[];
  capability: Capability;
  acceptanceChecks: string[];
  deadline?: string;
  costBudgetUsd?: number;
  provenanceRequired: boolean;
  outputSchemaVersion: number;
}

/**
 * A detached operator signature over one record's payload. A record that
 * asserts a human decided something carries `decidedBy: 'human'`, which is a
 * claim the bundle makes about itself and nothing more: a bundle is a local
 * JSON file, so an agent that can write the file can write the claim. The
 * attestation is the part a bundle cannot assert about itself, because the key
 * never enters the bundle.
 *
 * The signature is over the record's canonical JSON with the attestation
 * removed, so adding or altering the attestation never invalidates the payload
 * digest and never lets a signature be replayed onto a different payload.
 * keyId names the entry in the store manifest that holds the public key; the
 * private key stays with the operator and is never read into a bundle.
 */
export interface Attestation {
  keyId: string;
  algorithm: 'ed25519';
  payloadDigest: string;
  signature: string;
  signedAt: string;
}

export interface ApprovalRecord {
  version: 1;
  approvalId: string;
  caseId: string;
  taskId: string;
  effect: string;
  payloadDigest: string;
  decision: ApprovalDecision;
  decidedBy: 'human';
  decidedAt: string;
  rationale?: string;
  attestation?: Attestation;
}

export interface RecordedCost {
  amount: number;
  source: CostSource;
}

export interface OutcomeRecord {
  version: 1;
  outcomeId: string;
  caseId: string;
  disposition: CaseDisposition;
  recordedBy: 'human';
  recordedAt: string;
  receiptReference?: string;
  actualCostUsd?: RecordedCost;
  rationale?: string;
  attestation?: Attestation;
}

/**
 * A human confirming that one exact asset sits inside one current policy
 * snapshot. Deliberately not an ApprovalRecord: an approval's free-text effect
 * cannot carry the pin, so a confirmation that would survive a later policy
 * change or a different asset would be trivially transplantable. Both
 * policySnapshotId and asset are copied here precisely so the pair can be
 * compared against the case at evaluation time.
 */
export interface ConfirmationRecord {
  version: 1;
  confirmationId: string;
  caseId: string;
  confirmedBy: 'human';
  confirmedAt: string;
  policySnapshotId: string;
  asset: string;
  statement: string;
  attestation?: Attestation;
}

/**
 * The program's own published material, captured by the operator. Everything
 * here is quoted as published. rewardSchedulePublished is a string on purpose:
 * parsing a payout into a number would invite scoring by expected value, which
 * the design rules out.
 */
export interface ProgramRecord {
  version: 1;
  programId: string;
  displayName: string;
  policySnapshotId: string;
  bountyAssetTypes: string[];
  rewardSchedulePublished: string;
  rewardCategoriesPublished: string[];
  reportRequirements: string[];
  testingConstraints: string[];
  severityRubric?: string;
  capturedAt: string;
}

export interface DuplicateSearchRecord {
  version: 1;
  searchId: string;
  caseId: string;
  searchedAt: string;
  /** Where the search was actually run; a claimed search with no surface is not one. */
  surfaceCovered: string;
  /** Required: similarity is a lead, not proof of duplication. */
  similarityCaveat: string;
  matchedCaseIds: string[];
  performedBy: 'human';
  attestation?: Attestation;
}

export interface AssessmentRecord {
  version: 1;
  assessmentId: string;
  caseId: string;
  factor: AssessableFactor;
  level: RankLevel;
  basis: string;
  refId: string;
  assessedBy: 'human';
  assessedAt: string;
  attestation?: Attestation;
}

export interface CaseBundle {
  version: 1;
  scope: BountyScopeManifest[];
  programs: ProgramRecord[];
  cases: CaseRecord[];
  sources: SourceRecord[];
  evidence: EvidenceRecord[];
  tasks: TaskContract[];
  approvals: ApprovalRecord[];
  confirmations: ConfirmationRecord[];
  duplicateSearches: DuplicateSearchRecord[];
  assessments: AssessmentRecord[];
  outcomes: OutcomeRecord[];
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function instant(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!ISO_INSTANT.test(text) || Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp such as 2026-09-30T12:00:00Z`);
  }
  return text;
}

function digest(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!SHA256_DIGEST.test(text)) {
    throw new Error(`${field} must be a sha256:<64 lowercase hex> content digest`);
  }
  return text;
}

function positiveAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

function schemaVersion(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be true or false`);
  return value;
}

const ATTESTATION_ALGORITHMS = ['ed25519'] as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses a detached operator signature. The payloadDigest and signature are
 * shape-checked only: whether they are real is a cryptographic question
 * answered by verifyRecord in store.ts, not by the schema layer. Keeping that
 * split means a bundle can be validated as a document without pretending to be
 * authenticated, which is exactly what a bundle on disk is.
 */
export function parseAttestation(input: unknown): Attestation {
  const value = record(input, 'attestation');
  assertKnownKeys(
    value,
    ['keyId', 'algorithm', 'payloadDigest', 'signature', 'signedAt'],
    'attestation'
  );
  const signature = requiredString(value.signature, 'attestation.signature');
  if (!BASE64.test(signature)) {
    throw new Error('attestation.signature must be base64');
  }
  return {
    keyId: requiredString(value.keyId, 'attestation.keyId'),
    algorithm: oneOf(value.algorithm, ATTESTATION_ALGORITHMS, 'attestation.algorithm'),
    payloadDigest: digest(value.payloadDigest, 'attestation.payloadDigest'),
    signature,
    signedAt: instant(value.signedAt, 'attestation.signedAt'),
  };
}

function optionalAttestation(value: unknown): Attestation | undefined {
  return value === undefined ? undefined : parseAttestation(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has an unknown field ${key}`);
  }
}

function versioned<T>(
  label: string,
  input: unknown,
  allowed: readonly string[],
  build: (value: Record<string, unknown>) => T
): T {
  const value = record(input, label);
  if (value.version !== 1) throw new Error(`${label} version must be 1`);
  assertKnownKeys(value, ['version', ...allowed], label);
  return build(value);
}

function list<T>(value: unknown, field: string, parse: (item: unknown) => T, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of ${label}`);
  return value.map((item) => parse(item));
}

/** Compares a restated derived identity against the derived one, field by field. */
function sameIdentity(left: unknown, right: AssetIdentity): boolean {
  if (typeof left !== 'object' || left === null) return false;
  const stated = left as Record<string, unknown>;
  return Object.keys(stated).length === Object.keys(right).length &&
    Object.entries(right).every(([key, entry]) => stated[key] === entry);
}

export function parseCaseRecord(input: unknown): CaseRecord {
  return versioned('Case record', input, [
    'caseId',
    'objective',
    'programId',
    'assetOriginal',
    'asset',
    'assetType',
    'policySnapshotId',
    'createdAt',
    'state',
  ], (value) => {
    const assetOriginal = requiredString(value.assetOriginal, 'assetOriginal');
    const asset = normalizeAsset(assetOriginal);
    // `asset` is derived, so a bundle that carries it may only restate what the
    // derivation produced. Without this check a store could round-trip a bundle
    // whose asset no longer matches the asset the intake source recorded, and the
    // scope gate would score the restated one.
    if (value.asset !== undefined && !sameIdentity(value.asset, asset)) {
      throw new Error('Case record asset must be the identity derived from assetOriginal');
    }
    return {
      version: 1,
      caseId: requiredString(value.caseId, 'caseId'),
      objective: requiredString(value.objective, 'objective'),
      programId: requiredString(value.programId, 'programId'),
      assetOriginal,
      asset,
      assetType: requiredString(value.assetType, 'assetType'),
      policySnapshotId: requiredString(value.policySnapshotId, 'policySnapshotId'),
      createdAt: instant(value.createdAt, 'createdAt'),
      state: oneOf(value.state, CASE_STATES, 'state'),
    };
  });
}

export function parseSourceRecord(input: unknown): SourceRecord {
  return versioned('Source record', input, [
    'sourceId',
    'uri',
    'owner',
    'kind',
    'observedAt',
    'policyVersion',
    'contentDigest',
    'retention',
  ], (value) => ({
    version: 1,
    sourceId: requiredString(value.sourceId, 'sourceId'),
    uri: requiredString(value.uri, 'uri'),
    ...(optionalString(value.owner, 'owner') ? { owner: optionalString(value.owner, 'owner') } : {}),
    kind: oneOf(value.kind, SOURCE_KINDS, 'kind'),
    observedAt: instant(value.observedAt, 'observedAt'),
    ...(optionalString(value.policyVersion, 'policyVersion')
      ? { policyVersion: optionalString(value.policyVersion, 'policyVersion') }
      : {}),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    retention: oneOf(value.retention, RETENTION_CLASSES, 'retention'),
  }));
}

export function parseEvidenceRecord(input: unknown): EvidenceRecord {
  return versioned('Evidence record', input, [
    'evidenceId',
    'caseId',
    'claim',
    'claimType',
    'sourceId',
    'observedAt',
    'confidenceReason',
    'verification',
  ], (value) => {
    const claimType = oneOf(value.claimType, CLAIM_TYPES, 'claimType');
    const verification = oneOf(value.verification, VERIFICATIONS, 'verification');
    if (claimType === 'fact' && verification === 'unverified') {
      throw new Error('a fact claim requires verification of deterministic or operator_confirmed');
    }
    return {
      version: 1,
      evidenceId: requiredString(value.evidenceId, 'evidenceId'),
      caseId: requiredString(value.caseId, 'caseId'),
      claim: requiredString(value.claim, 'claim'),
      claimType,
      sourceId: requiredString(value.sourceId, 'sourceId'),
      observedAt: instant(value.observedAt, 'observedAt'),
      confidenceReason: requiredString(value.confidenceReason, 'confidenceReason'),
      verification,
    };
  });
}

export function parseTaskContract(input: unknown): TaskContract {
  return versioned('Task contract', input, [
    'taskId',
    'caseId',
    'role',
    'goal',
    'workspaceRef',
    'readRefs',
    'writablePaths',
    'capability',
    'acceptanceChecks',
    'deadline',
    'costBudgetUsd',
    'provenanceRequired',
    'outputSchemaVersion',
  ], (value) => {
    if (value.capability === 'sign_transfer') {
      throw new Error('capability sign_transfer is not in the MVP; signing keys are never stored');
    }
    const capability = oneOf(value.capability, CAPABILITIES, 'capability');
    const writablePaths = value.writablePaths === undefined
      ? []
      : stringList(value.writablePaths, 'writablePaths');
    if (writablePaths.length > 0 && !WRITE_CAPABILITIES.includes(capability)) {
      throw new Error(
        `writablePaths require the modify or submit_publish capability, not ${capability}`
      );
    }
    for (const path of writablePaths) assertDeclarablePath(path, 'writablePaths');
    const deadline = value.deadline === undefined ? undefined : instant(value.deadline, 'deadline');
    const costBudgetUsd = value.costBudgetUsd === undefined
      ? undefined
      : positiveAmount(value.costBudgetUsd, 'costBudgetUsd');
    const workspaceRef = optionalString(value.workspaceRef, 'workspaceRef');
    return {
      version: 1,
      taskId: requiredString(value.taskId, 'taskId'),
      caseId: requiredString(value.caseId, 'caseId'),
      role: oneOf(value.role, AGENT_ROLES, 'role'),
      goal: requiredString(value.goal, 'goal'),
      ...(workspaceRef ? { workspaceRef } : {}),
      readRefs: stringList(value.readRefs, 'readRefs'),
      writablePaths,
      capability,
      acceptanceChecks: stringList(value.acceptanceChecks, 'acceptanceChecks'),
      ...(deadline ? { deadline } : {}),
      ...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
      provenanceRequired: boolean(value.provenanceRequired, 'provenanceRequired'),
      outputSchemaVersion: schemaVersion(value.outputSchemaVersion, 'outputSchemaVersion'),
    };
  });
}

export function parseApprovalRecord(input: unknown): ApprovalRecord {
  return versioned('Approval record', input, [
    'approvalId',
    'caseId',
    'taskId',
    'effect',
    'payloadDigest',
    'decision',
    'decidedBy',
    'decidedAt',
    'rationale',
    'attestation',
  ], (value) => {
    if (value.decidedBy !== 'human') {
      throw new Error('decidedBy must be human; an approval is never recorded by an agent');
    }
    const rationale = optionalString(value.rationale, 'rationale');
    const attestation = optionalAttestation(value.attestation);
    return {
      version: 1,
      approvalId: requiredString(value.approvalId, 'approvalId'),
      caseId: requiredString(value.caseId, 'caseId'),
      taskId: requiredString(value.taskId, 'taskId'),
      effect: requiredString(value.effect, 'effect'),
      payloadDigest: digest(value.payloadDigest, 'payloadDigest'),
      decision: oneOf(value.decision, APPROVAL_DECISIONS, 'decision'),
      decidedBy: 'human',
      decidedAt: instant(value.decidedAt, 'decidedAt'),
      ...(rationale ? { rationale } : {}),
      ...(attestation ? { attestation } : {}),
    };
  });
}

export function parseOutcomeRecord(input: unknown): OutcomeRecord {
  return versioned('Outcome record', input, [
    'outcomeId',
    'caseId',
    'disposition',
    'recordedBy',
    'recordedAt',
    'receiptReference',
    'actualCostUsd',
    'rationale',
    'attestation',
  ], (value) => {
    if (value.recordedBy !== 'human') {
      throw new Error('recordedBy must be human; an outcome is never recorded by an agent');
    }
    const disposition = oneOf(value.disposition, DISPOSITIONS, 'disposition');
    const receiptReference = optionalString(value.receiptReference, 'receiptReference');
    if (disposition === 'paid' && !receiptReference) {
      throw new Error('a paid outcome requires a receiptReference; a published reward is not payment');
    }
    const rationale = optionalString(value.rationale, 'rationale');
    const actualCostUsd = value.actualCostUsd === undefined
      ? undefined
      : (() => {
          const cost = record(value.actualCostUsd, 'actualCostUsd');
          return {
            amount: positiveAmount(cost.amount, 'actualCostUsd.amount'),
            source: oneOf(cost.source, COST_SOURCES, 'actualCostUsd.source'),
          };
        })();
    const attestation = optionalAttestation(value.attestation);
    return {
      version: 1,
      outcomeId: requiredString(value.outcomeId, 'outcomeId'),
      caseId: requiredString(value.caseId, 'caseId'),
      disposition,
      recordedBy: 'human',
      recordedAt: instant(value.recordedAt, 'recordedAt'),
      ...(receiptReference ? { receiptReference } : {}),
      ...(actualCostUsd ? { actualCostUsd } : {}),
      ...(rationale ? { rationale } : {}),
      ...(attestation ? { attestation } : {}),
    };
  });
}

export function parseConfirmationRecord(input: unknown): ConfirmationRecord {
  return versioned('Confirmation record', input, [
    'confirmationId',
    'caseId',
    'confirmedBy',
    'confirmedAt',
    'policySnapshotId',
    'asset',
    'statement',
    'attestation',
  ], (value) => {
    if (value.confirmedBy !== 'human') {
      throw new Error('confirmedBy must be human; a confirmation is never recorded by an agent');
    }
    const identity = normalizeAsset(requiredString(value.asset, 'asset'));
    if (identity.status !== 'exact') {
      throw new Error('asset must be one exact HTTPS asset; a wildcard or ambiguous value confirms nothing');
    }
    const attestation = optionalAttestation(value.attestation);
    return {
      version: 1,
      confirmationId: requiredString(value.confirmationId, 'confirmationId'),
      caseId: requiredString(value.caseId, 'caseId'),
      confirmedBy: 'human',
      confirmedAt: instant(value.confirmedAt, 'confirmedAt'),
      policySnapshotId: requiredString(value.policySnapshotId, 'policySnapshotId'),
      asset: identity.canonical,
      statement: requiredString(value.statement, 'statement'),
      ...(attestation ? { attestation } : {}),
    };
  });
}

export function parseProgramRecord(input: unknown): ProgramRecord {
  return versioned('Program record', input, [
    'programId',
    'displayName',
    'policySnapshotId',
    'bountyAssetTypes',
    'rewardSchedulePublished',
    'rewardCategoriesPublished',
    'reportRequirements',
    'testingConstraints',
    'severityRubric',
    'capturedAt',
  ], (value) => {
    const severityRubric = optionalString(value.severityRubric, 'severityRubric');
    return {
      version: 1,
      programId: requiredString(value.programId, 'programId'),
      displayName: requiredString(value.displayName, 'displayName'),
      policySnapshotId: requiredString(value.policySnapshotId, 'policySnapshotId'),
      bountyAssetTypes: stringList(value.bountyAssetTypes, 'bountyAssetTypes'),
      rewardSchedulePublished: requiredString(
        value.rewardSchedulePublished,
        'rewardSchedulePublished'
      ),
      rewardCategoriesPublished: stringList(
        value.rewardCategoriesPublished,
        'rewardCategoriesPublished'
      ),
      reportRequirements: stringList(value.reportRequirements, 'reportRequirements'),
      testingConstraints: stringList(value.testingConstraints, 'testingConstraints'),
      ...(severityRubric ? { severityRubric } : {}),
      capturedAt: instant(value.capturedAt, 'capturedAt'),
    };
  });
}

export function parseDuplicateSearchRecord(input: unknown): DuplicateSearchRecord {
  return versioned('Duplicate search record', input, [
    'searchId',
    'caseId',
    'searchedAt',
    'surfaceCovered',
    'similarityCaveat',
    'matchedCaseIds',
    'performedBy',
    'attestation',
  ], (value) => {
    if (value.performedBy !== 'human') {
      throw new Error('performedBy must be human; a duplicate search is never claimed by an agent');
    }
    const attestation = optionalAttestation(value.attestation);
    return {
      version: 1,
      searchId: requiredString(value.searchId, 'searchId'),
      caseId: requiredString(value.caseId, 'caseId'),
      searchedAt: instant(value.searchedAt, 'searchedAt'),
      surfaceCovered: requiredString(value.surfaceCovered, 'surfaceCovered'),
      similarityCaveat: requiredString(value.similarityCaveat, 'similarityCaveat'),
      matchedCaseIds: stringList(value.matchedCaseIds, 'matchedCaseIds'),
      performedBy: 'human',
      ...(attestation ? { attestation } : {}),
    };
  });
}

export function parseAssessmentRecord(input: unknown): AssessmentRecord {
  return versioned('Assessment record', input, [
    'assessmentId',
    'caseId',
    'factor',
    'level',
    'basis',
    'refId',
    'assessedBy',
    'assessedAt',
    'attestation',
  ], (value) => {
    if (value.assessedBy !== 'human') {
      throw new Error('assessedBy must be human; an assessment is never recorded by an agent');
    }
    const factor = oneOf(value.factor, ASSESSABLE_FACTORS, 'factor');
    const level = oneOf(value.level, RANK_LEVELS, 'level');
    if (level === 'unknown') {
      throw new Error('level may not be unknown; a record that asserts nothing is not an assessment');
    }
    const attestation = optionalAttestation(value.attestation);
    return {
      version: 1,
      assessmentId: requiredString(value.assessmentId, 'assessmentId'),
      caseId: requiredString(value.caseId, 'caseId'),
      factor,
      level,
      basis: requiredString(value.basis, 'basis'),
      refId: requiredString(value.refId, 'refId'),
      assessedBy: 'human',
      assessedAt: instant(value.assessedAt, 'assessedAt'),
      ...(attestation ? { attestation } : {}),
    };
  });
}

export function parseCaseBundle(input: unknown): CaseBundle {
  const value = record(input, 'Case bundle');
  if (value.version !== 1) throw new Error('Case bundle version must be 1');
  assertKnownKeys(
    value,
    [
      'version',
      'scope',
      'programs',
      'cases',
      'sources',
      'evidence',
      'tasks',
      'approvals',
      'confirmations',
      'duplicateSearches',
      'assessments',
      'outcomes',
    ],
    'Case bundle'
  );
  return {
    version: 1,
    scope: list(value.scope, 'scope', parseBountyScope, 'scope manifests'),
    programs: list(value.programs, 'programs', parseProgramRecord, 'program records'),
    cases: list(value.cases, 'cases', parseCaseRecord, 'case records'),
    sources: list(value.sources, 'sources', parseSourceRecord, 'source records'),
    evidence: list(value.evidence, 'evidence', parseEvidenceRecord, 'evidence records'),
    tasks: list(value.tasks, 'tasks', parseTaskContract, 'task contracts'),
    approvals: list(value.approvals, 'approvals', parseApprovalRecord, 'approval records'),
    confirmations: list(value.confirmations, 'confirmations', parseConfirmationRecord, 'confirmation records'),
    duplicateSearches: list(
      value.duplicateSearches,
      'duplicateSearches',
      parseDuplicateSearchRecord,
      'duplicate search records'
    ),
    assessments: list(value.assessments, 'assessments', parseAssessmentRecord, 'assessment records'),
    outcomes: list(value.outcomes, 'outcomes', parseOutcomeRecord, 'outcome records'),
  };
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

interface BundleIndex {
  scopeByProgram: Map<string, BountyScopeManifest>;
  programs: Map<string, ProgramRecord>;
  cases: Map<string, CaseRecord>;
  sources: Map<string, SourceRecord>;
  evidence: Map<string, EvidenceRecord>;
  tasks: Map<string, TaskContract>;
  searches: Map<string, DuplicateSearchRecord>;
}

function indexBundle(bundle: CaseBundle): BundleIndex {
  return {
    scopeByProgram: new Map(bundle.scope.map((item) => [item.program, item])),
    programs: new Map(bundle.programs.map((item) => [item.programId, item])),
    cases: new Map(bundle.cases.map((item) => [item.caseId, item])),
    sources: new Map(bundle.sources.map((item) => [item.sourceId, item])),
    evidence: new Map(bundle.evidence.map((item) => [item.evidenceId, item])),
    tasks: new Map(bundle.tasks.map((item) => [item.taskId, item])),
    searches: new Map(bundle.duplicateSearches.map((item) => [item.searchId, item])),
  };
}

function duplicateIdProblems(bundle: CaseBundle): string[] {
  return duplicates([
    ...bundle.programs.map((item) => item.programId),
    ...bundle.cases.map((item) => item.caseId),
    ...bundle.sources.map((item) => item.sourceId),
    ...bundle.evidence.map((item) => item.evidenceId),
    ...bundle.tasks.map((item) => item.taskId),
    ...bundle.approvals.map((item) => item.approvalId),
    ...bundle.confirmations.map((item) => item.confirmationId),
    ...bundle.duplicateSearches.map((item) => item.searchId),
    ...bundle.assessments.map((item) => item.assessmentId),
    ...bundle.outcomes.map((item) => item.outcomeId),
  ]).map((id) => `duplicate record id ${id}`);
}

/**
 * Two snapshots claiming the same version with different content means the
 * version string is not a reliable identity, so a downgrade or an edit can hide
 * behind an unchanged label. Flagged rather than resolved: only a human who
 * fetched both documents knows which is current.
 */
function policyVersionProblems(bundle: CaseBundle): string[] {
  const byVersion = new Map<string, SourceRecord[]>();
  for (const source of bundle.sources) {
    if (source.kind !== 'policy_snapshot' || !source.policyVersion) continue;
    byVersion.set(source.policyVersion, [...(byVersion.get(source.policyVersion) ?? []), source]);
  }
  const problems: string[] = [];
  for (const [version, group] of byVersion) {
    const digests = new Set(group.map((item) => item.contentDigest));
    if (digests.size > 1) {
      problems.push(
        `policy snapshots ${group.map((item) => item.sourceId).join(', ')} share policyVersion ${version} but differ in content; the version string is not a reliable identity`
      );
    }
  }
  return problems;
}

function caseProblems(bundle: CaseBundle, index: BundleIndex): string[] {
  const problems: string[] = [];
  for (const item of bundle.cases) {
    if (!index.scopeByProgram.has(item.programId)) {
      problems.push(`case ${item.caseId}: programId ${item.programId} has no scope manifest`);
    }
    const snapshot = index.sources.get(item.policySnapshotId);
    if (!snapshot) {
      problems.push(`case ${item.caseId}: policySnapshotId ${item.policySnapshotId} has no source record`);
    } else if (snapshot.kind !== 'policy_snapshot') {
      problems.push(
        `case ${item.caseId}: policySnapshotId ${item.policySnapshotId} is a ${snapshot.kind} source, not a policy_snapshot`
      );
    }
  }
  return problems;
}

function programProblems(bundle: CaseBundle, index: BundleIndex): string[] {
  const problems: string[] = [];
  for (const item of bundle.programs) {
    const snapshot = index.sources.get(item.policySnapshotId);
    if (!snapshot) {
      problems.push(`program ${item.programId}: policySnapshotId ${item.policySnapshotId} has no source record`);
    } else if (snapshot.kind !== 'policy_snapshot') {
      problems.push(
        `program ${item.programId}: policySnapshotId ${item.policySnapshotId} is a ${snapshot.kind} source, not a policy_snapshot`
      );
    }
  }
  return problems;
}

/**
 * A confirmation that resolves but names a different asset or snapshot is not a
 * broken link, it is an inapplicable one, so it is reported as a review reason
 * by the ranking module rather than as a provenance problem here. What is
 * checked here is only that it points at a case that exists.
 */
function confirmationProblems(bundle: CaseBundle, index: BundleIndex): string[] {
  return bundle.confirmations
    .filter((item) => !index.cases.has(item.caseId))
    .map(
      (item) => `confirmation ${item.confirmationId}: caseId ${item.caseId} is not in the bundle`
    );
}

/**
 * A duplicate search must name a case in the bundle, and any match it reports
 * must be one too. Whether a search covers enough surface is the operator's
 * judgement, so that is not checked here.
 */
function duplicateSearchProblems(bundle: CaseBundle, index: BundleIndex): string[] {
  const problems: string[] = [];
  for (const item of bundle.duplicateSearches) {
    if (!index.cases.has(item.caseId)) {
      problems.push(`duplicate search ${item.searchId}: caseId ${item.caseId} is not in the bundle`);
    }
    for (const match of item.matchedCaseIds) {
      if (!index.cases.has(match)) {
        problems.push(`duplicate search ${item.searchId}: matchedCaseId ${match} is not in the bundle`);
      }
    }
  }
  return problems;
}

function assessmentProblems(bundle: CaseBundle, index: BundleIndex): string[] {
  const problems: string[] = [];
  for (const item of bundle.assessments) {
    const subject = index.cases.get(item.caseId);
    if (!subject) {
      problems.push(`assessment ${item.assessmentId}: caseId ${item.caseId} is not in the bundle`);
      continue;
    }
    if (CITES_PROGRAM.includes(item.factor)) {
      const cited = index.programs.get(item.refId);
      if (!cited) {
        problems.push(
          `assessment ${item.assessmentId}: factor ${item.factor} must cite a program record, and refId ${item.refId} is not one`
        );
      } else if (cited.programId !== subject.programId) {
        problems.push(
          `assessment ${item.assessmentId}: factor ${item.factor} cites program ${cited.programId}, but the case is under ${subject.programId}`
        );
      }
      continue;
    }
    if (item.factor === 'novelty') {
      const cited = index.searches.get(item.refId);
      if (!cited) {
        problems.push(
          `assessment ${item.assessmentId}: factor novelty must cite a duplicate search, and refId ${item.refId} is not one`
        );
      } else if (cited.caseId !== subject.caseId) {
        problems.push(
          `assessment ${item.assessmentId}: factor novelty cites duplicate search ${cited.searchId}, which belongs to case ${cited.caseId}`
        );
      }
      continue;
    }
    const resolves =
      index.programs.has(item.refId) ||
      index.sources.has(item.refId) ||
      index.evidence.has(item.refId) ||
      index.searches.has(item.refId);
    if (!resolves) {
      problems.push(`assessment ${item.assessmentId}: refId ${item.refId} resolves to no record in the bundle`);
    }
  }
  return problems;
}

export function validateCaseBundle(bundle: CaseBundle): string[] {
  const index = indexBundle(bundle);
  const problems: string[] = [
    ...duplicateIdProblems(bundle),
    ...policyVersionProblems(bundle),
    ...caseProblems(bundle, index),
    ...programProblems(bundle, index),
    ...confirmationProblems(bundle, index),
    ...duplicateSearchProblems(bundle, index),
    ...assessmentProblems(bundle, index),
  ];

  for (const item of bundle.evidence) {
    if (!index.cases.has(item.caseId)) {
      problems.push(`evidence ${item.evidenceId}: caseId ${item.caseId} is not in the bundle`);
    }
    if (!index.sources.has(item.sourceId)) {
      problems.push(`evidence ${item.evidenceId}: sourceId ${item.sourceId} has no source record`);
    }
  }

  for (const item of bundle.tasks) {
    if (!index.cases.has(item.caseId)) {
      problems.push(`task ${item.taskId}: caseId ${item.caseId} is not in the bundle`);
    }
    for (const ref of item.readRefs) {
      if (!index.evidence.has(ref) && !index.sources.has(ref)) {
        problems.push(`task ${item.taskId}: readRef ${ref} resolves to no evidence or source record`);
      }
    }
  }

  for (const item of bundle.approvals) {
    if (!index.cases.has(item.caseId)) {
      problems.push(`approval ${item.approvalId}: caseId ${item.caseId} is not in the bundle`);
    }
    if (!index.tasks.has(item.taskId)) {
      problems.push(`approval ${item.approvalId}: taskId ${item.taskId} is not in the bundle`);
    }
  }

  for (const item of bundle.outcomes) {
    if (!index.cases.has(item.caseId)) {
      problems.push(`outcome ${item.outcomeId}: caseId ${item.caseId} is not in the bundle`);
    }
  }

  return problems;
}

export async function loadCaseBundle(path: string): Promise<CaseBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid case bundle JSON: ${error.message}`);
    throw error;
  }
  return parseCaseBundle(parsed);
}