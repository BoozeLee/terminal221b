import { describe, expect, it } from 'vitest';
import { isTargetInScope, parseBountyScope } from '../src/scope.js';

const manifest = parseBountyScope({
  version: 1,
  program: 'Local fixture program',
  policyUrl: 'https://example.test/security',
  inScope: ['https://staging.example.test/api'],
  outOfScope: ['https://staging.example.test/api/admin'],
});

describe('bounty scope manifests', () => {
  it('allows only exact hosts and path-boundary matches', () => {
    expect(isTargetInScope('https://staging.example.test/api/v1', manifest)).toBe(true);
    expect(isTargetInScope('https://staging.example.test/api2', manifest)).toBe(false);
    expect(isTargetInScope('https://other.example.test/api', manifest)).toBe(false);
  });

  it('lets explicit out-of-scope paths override an in-scope prefix', () => {
    expect(isTargetInScope('https://staging.example.test/api/admin/users', manifest)).toBe(false);
  });

  it('rejects wildcards and non-HTTPS scope entries', () => {
    expect(() =>
      parseBountyScope({
        version: 1,
        program: 'fixture',
        policyUrl: 'https://example.test/policy',
        inScope: ['https://*.example.test'],
      })
    ).toThrow('must not contain wildcards');

    expect(() =>
      parseBountyScope({
        version: 1,
        program: 'fixture',
        policyUrl: 'https://example.test/policy',
        inScope: ['http://example.test'],
      })
    ).toThrow('must be HTTPS');
  });
});
