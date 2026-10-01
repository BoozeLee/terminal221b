import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { askAnthropic } from '../src/anthropic.js';
import { parseTaskContract } from '../src/case.js';
import {
  AGENT_ROLES,
  ROLE_PROFILES,
  clausesOf,
  profileForRole,
  renderSystemPrompt,
  textOf,
  universalClauses,
} from '../src/system-prompt.js';

const answer = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });

/**
 * The request the CLI builds for an ask. Mirrors the call site deliberately: if
 * the real call site stops consulting the role, this helper is what goes stale,
 * and `the cli resolves the profile through profileForRole` below reads the real
 * source to catch that.
 */
async function systemForRole(role: string | undefined): Promise<string> {
  const calls: unknown[][] = [];
  const fetchMock = async (...args: unknown[]) => {
    calls.push(args);
    return answer('an answer');
  };
  const profile = profileForRole(role as never);
  await askAnthropic(
    {
      apiKey: 'test-api-key',
      model: 'test-model',
      prompt: 'What does this workspace do?',
      context: 'untrusted text',
      system: renderSystemPrompt(profile),
      profile,
    },
    fetchMock as unknown as typeof fetch
  );
  const [, request] = calls[0]! as [string, RequestInit];
  return String((JSON.parse(String(request.body)) as { system: string }).system);
}

describe('the analyst profile', () => {
  it('renders, and renders text no other profile renders', () => {
    const analyst = renderSystemPrompt('analyst');
    expect(analyst.length).toBeGreaterThan(0);
    expect(analyst).not.toBe(renderSystemPrompt('coding'));
    expect(analyst).not.toBe(renderSystemPrompt('crypto'));
  });

  it('carries every universal prohibition', () => {
    for (const clause of universalClauses()) {
      expect(clausesOf('analyst')).toContain(clause);
    }
  });

  it('forbids proposing patches instead of merely describing them', () => {
    expect(clausesOf('analyst')).toContain('no_patch_proposals');
    expect(textOf('no_patch_proposals')).toMatch(/^Do not propose/);
    expect(renderSystemPrompt('analyst')).toContain('Do not propose patches or code changes');
  });

  it('keeps the prohibitions an analyst still needs', () => {
    const analyst = clausesOf('analyst');
    for (const clause of [
      'no_remote_target_testing',
      'no_remote_target_capability',
      'no_report_submission',
      'separate_facts_from_assumptions',
      'no_false_claims_of_change',
    ]) {
      expect(analyst).toContain(clause);
    }
  });

  it('omits patch_format, which would tell an analyst how to return a diff', () => {
    expect(clausesOf('analyst')).not.toContain('patch_format');
    expect(renderSystemPrompt('analyst')).not.toContain('unified git diff');
  });

  it('is never missing the clause it names, and never drops one it declares', () => {
    const text = renderSystemPrompt('analyst');
    for (const clause of clausesOf('analyst')) {
      expect(text).toContain(textOf(clause));
    }
  });
});

describe('the role is a parameter, not a label', () => {
  it('maps every role to a profile, and only analyst to its own', () => {
    for (const role of AGENT_ROLES) {
      expect(ROLE_PROFILES[role]).toBeDefined();
    }
    expect(ROLE_PROFILES.analyst).toBe('analyst');
    for (const role of AGENT_ROLES.filter((entry) => entry !== 'analyst')) {
      expect(ROLE_PROFILES[role]).toBe('coding');
    }
  });

  it('maps an absent role to coding, so an ask with no --role is unchanged', () => {
    expect(profileForRole(undefined)).toBe('coding');
    expect(renderSystemPrompt(profileForRole(undefined))).toBe(renderSystemPrompt('coding'));
  });

  it('changes the system text actually sent when the role changes', async () => {
    const plain = await systemForRole(undefined);
    const analyst = await systemForRole('analyst');
    const engineer = await systemForRole('engineer');

    expect(analyst).toContain('Do not propose patches or code changes');
    expect(plain).not.toContain('Do not propose patches or code changes');
    // An engineer's role is still a label, and says so in what is sent.
    expect(engineer).toBe(plain);
  });

  it('would fail if profileForRole ignored its argument', async () => {
    const analyst = await systemForRole('analyst');
    // The control: if the role were not consulted, this is what would be sent.
    const ifIgnored = await systemForRole(undefined);
    expect(analyst).not.toBe(ifIgnored);
    expect(profileForRole('analyst')).not.toBe(profileForRole(undefined));
  });

  it('the cli resolves the profile through profileForRole, not a literal', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(source).toContain('profileForRole(options.role)');
    // A hardcoded 'coding' on the non-crypto branch would make --role decorative.
    expect(source).not.toMatch(/cryptoMode \? 'crypto' : 'coding'/);
    expect(source).toContain('--role is not accepted by crypto ask');
  });

  it('agrees with the role vocabulary the contract parser accepts', () => {
    // `AGENT_ROLES` in case.ts is not exported and case.ts is outside this
    // slice's write scope, so the two lists are pinned through the parser's own
    // error message: it enumerates every role a TaskContract may carry. If either
    // list gains or loses a name, this string stops matching.
    expect(() => parseTaskContract(contractWithRole('not-a-role'))).toThrow(
      `role must be one of: ${AGENT_ROLES.join(', ')}`
    );
    for (const role of AGENT_ROLES) {
      expect(parseTaskContract(contractWithRole(role)).role).toBe(role);
    }
  });
});

function contractWithRole(role: string): unknown {
  return {
    version: 1,
    taskId: `task-${role}`,
    caseId: 'case-exact-in-scope',
    role,
    goal: 'describe the workspace',
    readRefs: ['src-policy-current'],
    writablePaths: [],
    capability: 'observe',
    acceptanceChecks: ['the summary cites a source'],
    provenanceRequired: true,
    outputSchemaVersion: 1,
  };
}