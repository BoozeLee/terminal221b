import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import type { LocalFinding } from './security.js';
import type { ToolStatus } from './tools.js';

interface GitleaksFinding {
  File?: unknown;
  StartLine?: unknown;
  RuleID?: unknown;
}

interface BanditFinding {
  filename?: unknown;
  line_number?: unknown;
  test_id?: unknown;
  issue_severity?: unknown;
  issue_text?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(output: string, analyzer: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`${analyzer} returned invalid JSON: ${detail}`);
  }
}

function relativeFindingPath(root: string, input: string): string {
  const absolute = resolve(root, input);
  const path = relative(root, absolute);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('Local analyzer reported a path outside the selected workspace');
  }
  return path.split(sep).join('/');
}

function runJson(
  executable: string,
  args: string[],
  root: string,
  analyzer: string
): unknown {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    maxBuffer: 5_000_000,
    timeout: 120_000,
  });
  if (result.error) {
    throw new Error(`Could not run ${analyzer}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${analyzer} failed (exit ${result.status}); stderr was suppressed.`);
  }
  return parseJson(result.stdout, analyzer);
}

function parseGitleaks(root: string, output: unknown): LocalFinding[] {
  if (!Array.isArray(output)) throw new Error('Gitleaks returned an unexpected report shape');
  return output.map((entry: GitleaksFinding) => {
    if (
      typeof entry.File !== 'string' ||
      typeof entry.StartLine !== 'number' ||
      typeof entry.RuleID !== 'string'
    ) {
      throw new Error('Gitleaks returned an incomplete finding');
    }
    return {
      file: relativeFindingPath(root, entry.File),
      line: entry.StartLine,
      rule: `gitleaks:${entry.RuleID}`,
      severity: 'high',
      message: 'Possible exposed credential detected by Gitleaks; value is hidden. Rotate if real.',
    };
  });
}

function parseBandit(root: string, output: unknown): LocalFinding[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    throw new Error('Bandit returned an unexpected report shape');
  }
  return output.results.map((entry: BanditFinding) => {
    if (
      typeof entry.filename !== 'string' ||
      typeof entry.line_number !== 'number' ||
      typeof entry.test_id !== 'string' ||
      typeof entry.issue_severity !== 'string' ||
      typeof entry.issue_text !== 'string'
    ) {
      throw new Error('Bandit returned an incomplete finding');
    }
    return {
      file: relativeFindingPath(root, entry.filename),
      line: entry.line_number,
      rule: `bandit:${entry.test_id}`,
      severity: 'review',
      message: `${entry.issue_severity}: ${entry.issue_text}`,
    };
  });
}

export function runLocalAnalyzers(
  root: string,
  sourceFiles: string[],
  tools: ToolStatus[],
  selected: { gitleaks: boolean; bandit: boolean }
): LocalFinding[] {
  const findings: LocalFinding[] = [];
  if (selected.gitleaks) {
    const gitleaks = tools.find((tool) => tool.name === 'Gitleaks')?.executable;
    if (!gitleaks) throw new Error('Gitleaks was requested but is not installed on PATH');
    const report = runJson(
      gitleaks,
      ['dir', root, '--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', '-'],
      root,
      'Gitleaks'
    );
    findings.push(...parseGitleaks(root, report));
  }

  const bandit = selected.bandit ? tools.find((tool) => tool.name === 'Bandit')?.executable : null;
  if (selected.bandit && !bandit) {
    throw new Error('Bandit was requested but is not installed on PATH');
  }
  const pythonFiles = sourceFiles
    .filter((path) => path.toLowerCase().endsWith('.py'))
    .map((path) => resolve(root, path));
  if (bandit && pythonFiles.length > 0) {
    for (let index = 0; index < pythonFiles.length; index += 50) {
      const report = runJson(
        bandit,
        ['-q', '--exit-zero', '-f', 'json', ...pythonFiles.slice(index, index + 50)],
        root,
        'Bandit'
      );
      findings.push(...parseBandit(root, report));
    }
  }
  return findings;
}
