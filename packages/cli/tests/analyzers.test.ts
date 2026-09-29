import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLocalAnalyzers } from '../src/analyzers.js';
import type { ToolStatus } from '../src/tools.js';

let root: string | undefined;

async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'terminal221b-analyzers-'));
  return root;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function tool(name: string, executable: string): ToolStatus {
  return {
    name,
    category: 'security',
    purpose: 'test',
    documentation: 'https://example.test',
    executable,
  };
}

function noAnalyzers() {
  return {
    gitleaks: false,
    bandit: false,
    semgrep: false,
    trivy: false,
    slither: false,
    cargoAudit: false,
  };
}

async function writeJsonTool(
  workspace: string,
  name: string,
  report: unknown,
  options: { exitCode?: number; requiredArgs?: string[] } = {}
): Promise<string> {
  const executable = join(workspace, name);
  const encoded = Buffer.from(JSON.stringify(report)).toString('base64');
  const argChecks = (options.requiredArgs ?? [])
    .map(
      (arg) =>
        `found=0; for actual in "$@"; do [ "$actual" = '${arg}' ] && found=1; done; [ "$found" = 1 ] || exit 2`
    )
    .join('\n');
  await writeFile(
    executable,
    `#!/bin/sh\n${argChecks}\nprintf '%s' '${encoded}' | base64 -d\nexit ${options.exitCode ?? 0}\n`,
    { mode: 0o755 }
  );
  return executable;
}

describe('runLocalAnalyzers', () => {
  it('redacts Gitleaks findings before returning them to the CLI', async () => {
    const workspace = await makeRoot();
    const executable = join(workspace, 'gitleaks-fixture');
    const report = JSON.stringify([
      {
        File: 'src/example.ts',
        StartLine: 4,
        RuleID: 'test-rule',
        Secret: 'fixture-secret-value',
      },
    ]);
    await writeFile(
      executable,
      `#!/bin/sh\n[ "$3" = "--redact" ] || exit 2\nprintf '%s' '${Buffer.from(report).toString('base64')}' | base64 -d\n`,
      { mode: 0o755 }
    );

    const findings = runLocalAnalyzers(
      workspace,
      [],
      [tool('Gitleaks', executable)],
      { ...noAnalyzers(), gitleaks: true }
    );

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'src/example.ts',
        line: 4,
        rule: 'gitleaks:test-rule',
        severity: 'high',
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain('fixture-secret-value');
  });

  it('runs Bandit only against selected local Python files', async () => {
    const workspace = await makeRoot();
    const source = join(workspace, 'sample.py');
    const executable = join(workspace, 'bandit-fixture');
    await writeFile(source, 'print("local fixture")\n');
    const report = {
      results: [
        {
          filename: source,
          line_number: 1,
          test_id: 'B101',
          issue_severity: 'LOW',
          issue_text: 'fixture assertion',
        },
      ],
    };
    await writeJsonTool(workspace, 'bandit-fixture', report);

    const findings = runLocalAnalyzers(
      workspace,
      ['sample.py'],
      [tool('Bandit', executable)],
      { ...noAnalyzers(), bandit: true }
    );

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'sample.py',
        rule: 'bandit:B101',
        severity: 'review',
      }),
    ]);
  });

  it('does not invoke scanners unless the user explicitly selects them', async () => {
    const workspace = await makeRoot();
    const executable = join(workspace, 'must-not-run');
    await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o755 });

    expect(
      runLocalAnalyzers(
        workspace,
        ['sample.py'],
        [tool('Gitleaks', executable), tool('Bandit', executable)],
        noAnalyzers()
      )
    ).toEqual([]);
  });

  it('passes local cache directories without forwarding provider credentials', async () => {
    const workspace = await makeRoot();
    const executable = join(workspace, 'environment-check');
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fixture-provider-key';
    await writeFile(
      executable,
      '#!/bin/sh\n[ -n \"$HOME\" ] || exit 2\n[ -z \"${ANTHROPIC_API_KEY:-}\" ] || exit 3\nprintf \"[]\"\n',
      { mode: 0o755 }
    );

    try {
      expect(
        runLocalAnalyzers(
          workspace,
          [],
          [tool('Gitleaks', executable)],
          { ...noAnalyzers(), gitleaks: true }
        )
      ).toEqual([]);
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it('suppresses scanner stderr when the requested scan cannot run cleanly', async () => {
    const workspace = await makeRoot();
    const executable = join(workspace, 'broken-gitleaks');
    const sentinel = 'fixture-secret-that-must-not-leak';
    await writeFile(
      executable,
      `#!/bin/sh\necho '${sentinel}' >&2\nexit 2\n`,
      { mode: 0o755 }
    );

    expect(() =>
      runLocalAnalyzers(
        workspace,
        [],
        [tool('Gitleaks', executable)],
        { ...noAnalyzers(), gitleaks: true }
      )
    ).toThrow('stderr was suppressed');
  });

  it('runs Semgrep with local rules and hides raw messages', async () => {
    const workspace = await makeRoot();
    const executable = await writeJsonTool(
      workspace,
      'semgrep-fixture',
      {
        results: [
          {
            path: 'sample.py',
            start: { line: 7 },
            check_id: 'local.rule',
            extra: { severity: 'WARNING', message: 'sensitive source excerpt' },
          },
        ],
      },
      { requiredArgs: ['--metrics=off', '--no-rewrite-rule-ids'] }
    );

    const findings = runLocalAnalyzers(
      workspace,
      ['sample.py'],
      [tool('Semgrep', executable)],
      { ...noAnalyzers(), semgrep: true }
    );

    expect(findings[0]).toMatchObject({
      file: 'sample.py',
      line: 7,
      rule: 'semgrep:local.rule',
      severity: 'review',
    });
    expect(JSON.stringify(findings)).not.toContain('sensitive source excerpt');
  });

  it('summarizes Trivy metadata without returning secret values', async () => {
    const workspace = await makeRoot();
    const executable = await writeJsonTool(
      workspace,
      'trivy-fixture',
      {
        Results: [
          {
            Target: 'package.json',
            Secrets: [
              {
                RuleID: 'generic-secret',
                StartLine: 3,
                Severity: 'HIGH',
                Match: 'sensitive credential value',
              },
            ],
          },
        ],
      },
      { requiredArgs: ['--offline-scan', '--skip-db-update'] }
    );

    const findings = runLocalAnalyzers(
      workspace,
      [],
      [tool('Trivy', executable)],
      { ...noAnalyzers(), trivy: true }
    );

    expect(findings[0]).toMatchObject({
      file: 'package.json',
      line: 3,
      rule: 'trivy:generic-secret',
      severity: 'high',
    });
    expect(JSON.stringify(findings)).not.toContain('sensitive credential value');
  });

  it('runs Slither only on discovered Solidity files and hides detector text', async () => {
    const workspace = await makeRoot();
    const executable = await writeJsonTool(
      workspace,
      'slither-fixture',
      {
        success: true,
        results: {
          detectors: [
            {
              check: 'arbitrary-send',
              impact: 'High',
              elements: [
                {
                  source_mapping: {
                    filename_relative: 'Vault.sol',
                    lines: [12],
                  },
                },
              ],
              description: 'source excerpt with sensitive value',
            },
          ],
        },
      },
      { requiredArgs: ['--ignore-compile'] }
    );

    const findings = runLocalAnalyzers(
      workspace,
      ['Vault.sol'],
      [tool('Slither', executable)],
      { ...noAnalyzers(), slither: true }
    );

    expect(findings[0]).toMatchObject({
      file: 'Vault.sol',
      line: 12,
      rule: 'slither:arbitrary-send',
      severity: 'high',
    });
    expect(JSON.stringify(findings)).not.toContain('source excerpt with sensitive value');
  });

  it('uses cargo-audit without fetching the advisory database', async () => {
    const workspace = await makeRoot();
    const executable = await writeJsonTool(
      workspace,
      'cargo-audit-fixture',
      {
        vulnerabilities: {
          list: [
            {
              advisory: { id: 'RUSTSEC-0000-0001', severity: 'HIGH' },
              package: { name: 'fixture-crate', version: '1.0.0' },
            },
          ],
        },
      },
      { exitCode: 1, requiredArgs: ['--no-fetch', '--stale'] }
    );

    const findings = runLocalAnalyzers(
      workspace,
      ['Cargo.toml'],
      [tool('cargo-audit', executable)],
      { ...noAnalyzers(), cargoAudit: true }
    );

    expect(findings[0]).toMatchObject({
      file: 'Cargo.lock',
      rule: 'cargo-audit:RUSTSEC-0000-0001',
      severity: 'high',
    });
  });

  it('rejects analyzer findings outside the selected workspace', async () => {
    const workspace = await makeRoot();
    const executable = await writeJsonTool(workspace, 'semgrep-outside-fixture', {
      results: [
        {
          path: '../outside.py',
          start: { line: 1 },
          check_id: 'outside.rule',
          extra: { severity: 'ERROR' },
        },
      ],
    });

    expect(() =>
      runLocalAnalyzers(
        workspace,
        ['inside.py'],
        [tool('Semgrep', executable)],
        { ...noAnalyzers(), semgrep: true }
      )
    ).toThrow('outside the selected workspace');
  });
});
