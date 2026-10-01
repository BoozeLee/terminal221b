/**
 * The wire format, from blueprint §3.2.
 *
 * One envelope, so the next adapter is a third implementer of a format rather
 * than a fourth independent idea of one. The rules §3.2 states are enforced
 * here rather than restated in comments: an unknown event version, invalid
 * structured output, or missing provenance fails closed and stays visible, and
 * nothing is normalised away.
 *
 * This is a shape, not a transport. Nothing serialises it yet, because nothing
 * speaks it yet — see the slice boundary in the engineering guide, where the
 * contract-to-executor seam is still listed as not existing.
 */
import { createHash } from 'node:crypto';

export const ENVELOPE_VERSION = 1;

export const TASK_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_EVENT_KINDS = [
  'task_started',
  'progress',
  'observation',
  'tool_requested',
  'approval_required',
  'diff_proposed',
  'check_started',
  'check_finished',
  'finding',
  'task_finished',
  'task_failed',
  'task_cancelled',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export interface EnvelopeProblem {
  field: string;
  problem: string;
}

export interface ResultEnvelope {
  version: 1;
  taskId: string;
  adapter: string;
  adapterVersion: string;
  /** Absent when the adapter cannot know it, rather than guessed. */
  modelIfKnown?: string;
  status: TaskStatus;
  structuredResult?: unknown;
  evidenceRefs: string[];
  diffRef?: string;
  usageIfReported?: { inputTokens?: number; outputTokens?: number };
  startedAt: string;
  finishedAt: string;
  warnings: string[];
}

export interface AgentEvent {
  version: 1;
  taskId: string;
  kind: AgentEventKind;
  at: string;
  detail?: string;
}

const isInstant = (value: unknown): boolean =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * Returns every problem rather than the first, because an envelope that is
 * wrong in two ways should say so in one pass. An empty array means valid.
 */
export function validateEnvelope(value: unknown): EnvelopeProblem[] {
  const problems: EnvelopeProblem[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '', problem: 'an envelope must be an object' }];
  }
  const record = value as Record<string, unknown>;

  if (record.version !== ENVELOPE_VERSION) {
    problems.push({ field: 'version', problem: `must be ${ENVELOPE_VERSION}` });
  }
  for (const field of ['taskId', 'adapter', 'adapterVersion'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      problems.push({ field, problem: 'must be a non-empty string' });
    }
  }
  if (record.modelIfKnown !== undefined && typeof record.modelIfKnown !== 'string') {
    problems.push({ field: 'modelIfKnown', problem: 'must be a string when present' });
  }
  if (!TASK_STATUSES.includes(record.status as TaskStatus)) {
    problems.push({
      field: 'status',
      problem: `must be one of ${TASK_STATUSES.join(', ')}`,
    });
  }
  if (!Array.isArray(record.evidenceRefs)) {
    problems.push({ field: 'evidenceRefs', problem: 'must be an array' });
  } else if (record.evidenceRefs.some((item) => typeof item !== 'string')) {
    problems.push({ field: 'evidenceRefs', problem: 'every reference must be a string' });
  }
  if (record.diffRef !== undefined && typeof record.diffRef !== 'string') {
    problems.push({ field: 'diffRef', problem: 'must be a string when present' });
  }
  if (!isInstant(record.startedAt)) {
    problems.push({ field: 'startedAt', problem: 'must be an ISO-8601 instant' });
  }
  if (!isInstant(record.finishedAt)) {
    problems.push({ field: 'finishedAt', problem: 'must be an ISO-8601 instant' });
  }
  if (!Array.isArray(record.warnings)) {
    problems.push({ field: 'warnings', problem: 'must be an array' });
  } else if (record.warnings.some((item) => typeof item !== 'string')) {
    problems.push({ field: 'warnings', problem: 'every warning must be a string' });
  }
  if (record.usageIfReported !== undefined) {
    const usage = record.usageIfReported as Record<string, unknown>;
    for (const key of ['inputTokens', 'outputTokens']) {
      const amount = usage[key];
      if (amount !== undefined && (!Number.isInteger(amount) || (amount as number) < 0)) {
        problems.push({ field: `usageIfReported.${key}`, problem: 'must be a non-negative integer' });
      }
    }
  }
  return problems;
}

export function parseEnvelope(value: unknown): ResultEnvelope {
  const problems = validateEnvelope(value);
  if (problems.length > 0) {
    throw new Error(
      `result envelope is not valid:\n  ${problems
        .map((item) => (item.field === '' ? item.problem : `${item.field} ${item.problem}`))
        .join('\n  ')}`
    );
  }
  return value as ResultEnvelope;
}

export function parseAgentEvent(value: unknown): AgentEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('an agent event must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== ENVELOPE_VERSION) {
    throw new Error(`unknown agent event version: ${String(record.version)}`);
  }
  if (typeof record.taskId !== 'string' || record.taskId === '') {
    throw new Error('agent event needs a taskId');
  }
  if (!AGENT_EVENT_KINDS.includes(record.kind as AgentEventKind)) {
    throw new Error(`unknown agent event kind: ${String(record.kind)}`);
  }
  if (!isInstant(record.at)) {
    throw new Error('agent event needs an ISO-8601 at');
  }
  if (record.detail !== undefined && typeof record.detail !== 'string') {
    throw new Error('agent event detail must be a string when present');
  }
  return value as AgentEvent;
}

/**
 * A model-produced path or URI is a claim, not a location. §3.2 requires the
 * coordinator to resolve and validate it, so this never returns a usable path;
 * it returns whether the claim is well-formed, and the answer is still no until
 * something else says otherwise.
 */
export function isUnresolvedClaim(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('..') || value.includes('\0')) return true;
  if (/^file:\/\//.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  return value.startsWith('/');
}

export function envelopeDigest(envelope: ResultEnvelope): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(envelope)).digest('hex')}`;
}
