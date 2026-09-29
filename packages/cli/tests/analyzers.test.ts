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
      `#!/bin/sh\n[ "$3" = "--redact" ] || exit 2\nprintf '%s' '${report}'\n`,
      { mode: 0o755 }
    );

    const findings = runLocalAnalyzers(
      workspace,
      [],
      [tool('Gitleaks', executable)],
      { gitleaks: true, bandit: false }
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
    const report = JSON.stringify({
      results: [
        {
          filename: source,
          line_number: 1,
          test_id: 'B101',
          issue_severity: 'LOW',
          issue_text: 'fixture assertion',
        },
      ],
    });
    await writeFile(executable, `#!/bin/sh\nprintf '%s' '${report}'\n`, { mode: 0o755 });

    const findings = runLocalAnalyzers(
      workspace,
      ['sample.py'],
      [tool('Bandit', executable)],
      { gitleaks: false, bandit: true }
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
        { gitleaks: false, bandit: false }
      )
    ).toEqual([]);
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
        { gitleaks: true, bandit: false }
      )
    ).toThrow('stderr was suppressed');
  });
});
