import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_KINDS,
  ENVELOPE_VERSION,
  TASK_STATUSES,
  envelopeDigest,
  isUnresolvedClaim,
  parseAgentEvent,
  parseEnvelope,
  validateEnvelope,
  type ResultEnvelope,
} from '../src/envelope.js';

const valid: ResultEnvelope = {
  version: 1,
  taskId: 'task-exact-in-scope',
  adapter: 'anthropic',
  adapterVersion: '1',
  modelIfKnown: 'claude-sonnet-4-5-20250929',
  status: 'completed',
  structuredResult: { text: 'answer' },
  evidenceRefs: ['src-policy-current'],
  startedAt: '2026-09-30T12:00:00Z',
  finishedAt: '2026-09-30T12:00:05Z',
  warnings: [],
};

describe('the envelope fails closed and stays visible', () => {
  it('accepts a well-formed envelope', () => {
    expect(validateEnvelope(valid)).toEqual([]);
    expect(parseEnvelope(valid)).toEqual(valid);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = validateEnvelope({ ...valid, version: 2, status: 'weird', evidenceRefs: 'no' });
    expect(problems.map((item) => item.field).sort()).toEqual(['evidenceRefs', 'status', 'version']);
  });

  it('refuses an unknown version rather than guessing', () => {
    expect(() => parseEnvelope({ ...valid, version: 99 })).toThrow(/version must be 1/);
  });

  it('refuses a non-object outright', () => {
    expect(validateEnvelope(null)).toEqual([{ field: '', problem: 'an envelope must be an object' }]);
    expect(validateEnvelope([])).toHaveLength(1);
  });

  it('requires the identity fields that make an envelope attributable', () => {
    for (const field of ['taskId', 'adapter', 'adapterVersion'] as const) {
      const problems = validateEnvelope({ ...valid, [field]: '' });
      expect(problems.map((item) => item.field)).toContain(field);
    }
  });

  it('leaves the model absent rather than guessing one', () => {
    const withoutModel = { ...valid };
    delete (withoutModel as { modelIfKnown?: string }).modelIfKnown;
    expect(validateEnvelope(withoutModel)).toEqual([]);
  });

  it('refuses a non-integer or negative token count', () => {
    expect(validateEnvelope({ ...valid, usageIfReported: { inputTokens: 1.5 } })).toHaveLength(1);
    expect(validateEnvelope({ ...valid, usageIfReported: { outputTokens: -1 } })).toHaveLength(1);
    expect(validateEnvelope({ ...valid, usageIfReported: { inputTokens: 10 } })).toEqual([]);
  });

  it('requires real instants on both ends', () => {
    expect(validateEnvelope({ ...valid, startedAt: 'soon' })).toHaveLength(1);
    expect(validateEnvelope({ ...valid, finishedAt: 5 })).toHaveLength(1);
  });

  it('enumerates statuses and event kinds so an adapter cannot invent one', () => {
    expect(TASK_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'blocked']);
    expect(AGENT_EVENT_KINDS).toContain('approval_required');
    expect(AGENT_EVENT_KINDS).toContain('diff_proposed');
    expect(validateEnvelope({ ...valid, status: 'pending' })).toHaveLength(1);
  });

  it('produces the same digest for the same envelope', () => {
    expect(envelopeDigest(valid)).toBe(envelopeDigest({ ...valid }));
    expect(envelopeDigest(valid)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('a model-produced path is a claim until something resolves it', () => {
  it('flags a traversal, a null byte, an absolute path, and any uri', () => {
    expect(isUnresolvedClaim('../etc/passwd')).toBe(true);
    expect(isUnresolvedClaim('a\0b')).toBe(true);
    expect(isUnresolvedClaim('/etc/passwd')).toBe(true);
    expect(isUnresolvedClaim('file:///etc/passwd')).toBe(true);
    expect(isUnresolvedClaim('https://example.invalid/x')).toBe(true);
  });

  it('does not flag a plain relative path, which is still a claim but a well-formed one', () => {
    expect(isUnresolvedClaim('patches/a.diff')).toBe(false);
    expect(isUnresolvedClaim('')).toBe(false);
  });
});

describe('an unknown event version is refused rather than normalised', () => {
  it('accepts a known kind', () => {
    const event = { version: 1, taskId: 't', kind: 'diff_proposed', at: '2026-09-30T12:00:00Z' };
    expect(parseAgentEvent(event)).toEqual(event);
  });

  it('refuses an unknown version, an unknown kind, and a bad instant', () => {
    expect(() => parseAgentEvent({ version: 2, taskId: 't', kind: 'progress', at: '2026-09-30T12:00:00Z' })).toThrow(
      /unknown agent event version/
    );
    expect(() => parseAgentEvent({ version: 1, taskId: 't', kind: 'teleported', at: '2026-09-30T12:00:00Z' })).toThrow(
      /unknown agent event kind/
    );
    expect(() => parseAgentEvent({ version: 1, taskId: 't', kind: 'progress', at: 'later' })).toThrow(
      /ISO-8601/
    );
  });

  it('refuses an event with no task, because it cannot be attributed', () => {
    expect(() => parseAgentEvent({ version: 1, kind: 'progress', at: '2026-09-30T12:00:00Z' })).toThrow(
      /taskId/
    );
  });

  it('pins the version constant so a schema bump is a visible diff', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});
