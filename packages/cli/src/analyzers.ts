import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
}

interface SemgrepFinding {
  path?: unknown;
  start?: unknown;
  check_id?: unknown;
  extra?: unknown;
}

interface TrivyReport {
  Results?: unknown;
}

interface CargoAuditReport {
  vulnerabilities?: unknown;
}

export interface AnalyzerSelection {
  gitleaks: boolean;
  bandit: boolean;
  semgrep: boolean;
  trivy: boolean;
  slither: boolean;
  cargoAudit: boolean;
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
  analyzer: string,
  allowedExitCodes = [0]
): unknown {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'CARGO_HOME', 'FOUNDRY_DIR']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 5_000_000,
    timeout: 120_000,
  });
  if (result.error) {
    throw new Error(`Could not run ${analyzer}: ${result.error.message}`);
  }
  if (!allowedExitCodes.includes(result.status ?? -1)) {
    throw new Error(`${analyzer} failed (exit ${result.status}); stderr was suppressed.`);
  }
  return parseJson(result.stdout, analyzer);
}

function toolPath(
  name: string,
  tools: ToolStatus[],
  selected: boolean
): string | undefined {
  if (!selected) return undefined;
  const executable = tools.find((tool) => tool.name === name)?.executable;
  if (!executable) throw new Error(`${name} was requested but is not installed on PATH`);
  return executable;
}

function severity(value: unknown): LocalFinding['severity'] {
  if (typeof value === 'string' && ['CRITICAL', 'HIGH', 'ERROR'].includes(value.toUpperCase())) {
    return 'high';
  }
  return 'review';
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
      typeof entry.issue_severity !== 'string'
    ) {
      throw new Error('Bandit returned an incomplete finding');
    }
    return {
      file: relativeFindingPath(root, entry.filename),
      line: entry.line_number,
      rule: `bandit:${entry.test_id}`,
      severity: severity(entry.issue_severity),
      message: `Review finding from Bandit (${entry.issue_severity}); source values are hidden.`,
    };
  });
}

function parseSemgrep(root: string, output: unknown): LocalFinding[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    throw new Error('Semgrep returned an unexpected report shape');
  }
  return output.results.map((entry: SemgrepFinding) => {
    if (
      typeof entry.path !== 'string' ||
      typeof entry.check_id !== 'string' ||
      !isRecord(entry.start) ||
      typeof entry.start.line !== 'number' ||
      !isRecord(entry.extra)
    ) {
      throw new Error('Semgrep returned an incomplete finding');
    }
    return {
      file: relativeFindingPath(root, entry.path),
      line: entry.start.line,
      rule: `semgrep:${entry.check_id}`,
      severity: severity(entry.extra.severity),
      message: 'Review finding from the bundled local Semgrep rules; source values are hidden.',
    };
  });
}

function parseTrivy(root: string, output: unknown): LocalFinding[] {
  if (!isRecord(output) || !Array.isArray((output as TrivyReport).Results)) {
    throw new Error('Trivy returned an unexpected report shape');
  }
  const findings: LocalFinding[] = [];
  for (const result of (output as TrivyReport).Results as unknown[]) {
    if (!isRecord(result) || typeof result.Target !== 'string') {
      throw new Error('Trivy returned an incomplete result');
    }
    const file = relativeFindingPath(root, result.Target);
    for (const key of ['Vulnerabilities', 'Misconfigurations', 'Secrets'] as const) {
      const entries = result[key];
      if (entries === undefined || entries === null) continue;
      if (!Array.isArray(entries)) throw new Error('Trivy returned an invalid finding list');
      for (const finding of entries) {
        if (!isRecord(finding)) throw new Error('Trivy returned an incomplete finding');
        const id = finding.VulnerabilityID ?? finding.ID ?? finding.RuleID;
        if (typeof id !== 'string') throw new Error('Trivy finding did not include a rule ID');
        const line =
          isRecord(finding.StartLine) && typeof finding.StartLine.line === 'number'
            ? finding.StartLine.line
            : typeof finding.StartLine === 'number'
              ? finding.StartLine
              : 1;
        findings.push({
          file,
          line,
          rule: `trivy:${id}`,
          severity: severity(finding.Severity),
          message: `Review ${key.toLowerCase()} finding from Trivy; source values are hidden.`,
        });
      }
    }
  }
  return findings;
}

function parseSlither(root: string, output: unknown): LocalFinding[] {
  if (
    !isRecord(output) ||
    output.success !== true ||
    !isRecord(output.results) ||
    !Array.isArray(output.results.detectors)
  ) {
    throw new Error('Slither returned an unexpected report shape');
  }
  const findings: LocalFinding[] = [];
  for (const detector of output.results.detectors) {
    if (!isRecord(detector) || typeof detector.check !== 'string') {
      throw new Error('Slither returned an incomplete detector finding');
    }
    const elements = Array.isArray(detector.elements) ? detector.elements : [];
    const source = elements.find(
      (element) =>
        isRecord(element) &&
        isRecord(element.source_mapping) &&
        (typeof element.source_mapping.filename_absolute === 'string' ||
          typeof element.source_mapping.filename_relative === 'string')
    );
    if (!isRecord(source) || !isRecord(source.source_mapping)) continue;
    const mapping = source.source_mapping;
    const lines = Array.isArray(mapping.lines) ? mapping.lines : [];
    const line = lines.find((value): value is number => typeof value === 'number') ?? 1;
    const path =
      typeof mapping.filename_absolute === 'string'
        ? mapping.filename_absolute
        : mapping.filename_relative;
    if (typeof path !== 'string') continue;
    findings.push({
      file: relativeFindingPath(root, path),
      line,
      rule: `slither:${detector.check}`,
      severity: severity(detector.impact),
      message: 'Review finding from Slither; source values are hidden.',
    });
  }
  return findings;
}

function parseCargoAudit(output: unknown): LocalFinding[] {
  if (
    !isRecord(output) ||
    !isRecord((output as CargoAuditReport).vulnerabilities) ||
    !Array.isArray((output as Record<string, unknown>).vulnerabilities &&
      ((output as Record<string, unknown>).vulnerabilities as Record<string, unknown>).list)
  ) {
    throw new Error('cargo-audit returned an unexpected report shape');
  }
  const vulnerabilities = (output as Record<string, unknown>).vulnerabilities as Record<
    string,
    unknown
  >;
  return (vulnerabilities.list as unknown[]).map((entry) => {
    if (
      !isRecord(entry) ||
      !isRecord(entry.advisory) ||
      typeof entry.advisory.id !== 'string' ||
      !isRecord(entry.package) ||
      typeof entry.package.name !== 'string'
    ) {
      throw new Error('cargo-audit returned an incomplete advisory');
    }
    return {
      file: 'Cargo.lock',
      line: 1,
      rule: `cargo-audit:${entry.advisory.id}`,
      severity: severity(entry.advisory.severity),
      message: `Review advisory affecting crate ${entry.package.name}; details remain in the local report.`,
    };
  });
}

export function runLocalAnalyzers(
  root: string,
  sourceFiles: string[],
  tools: ToolStatus[],
  selected: AnalyzerSelection
): LocalFinding[] {
  const findings: LocalFinding[] = [];
  const gitleaks = toolPath('Gitleaks', tools, selected.gitleaks);
  if (gitleaks) {
    const report = runJson(
      gitleaks,
      ['dir', root, '--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', '-'],
      root,
      'Gitleaks'
    );
    findings.push(...parseGitleaks(root, report));
  }

  const bandit = toolPath('Bandit', tools, selected.bandit);
  const pythonFiles = sourceFiles
    .filter((path) => path.toLowerCase().endsWith('.py'))
    .map((path) => resolve(root, path));
  if (bandit) {
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

  const semgrep = toolPath('Semgrep', tools, selected.semgrep);
  if (semgrep) {
    const pythonAndSolidity = sourceFiles
      .filter((path) => ['.py', '.sol'].includes(path.slice(path.lastIndexOf('.')).toLowerCase()))
      .map((path) => resolve(root, path));
    const config = fileURLToPath(new URL('../resources/semgrep.yml', import.meta.url));
    for (let index = 0; index < pythonAndSolidity.length; index += 50) {
      const report = runJson(
        semgrep,
        [
          'scan',
          '--config',
          config,
          '--no-rewrite-rule-ids',
          '--metrics=off',
          '--quiet',
          '--json',
          ...pythonAndSolidity.slice(index, index + 50),
        ],
        root,
        'Semgrep'
      );
      findings.push(...parseSemgrep(root, report));
    }
  }

  const trivy = toolPath('Trivy', tools, selected.trivy);
  if (trivy) {
    const report = runJson(
      trivy,
      [
        'fs',
        '--offline-scan',
        '--skip-db-update',
        '--skip-java-db-update',
        '--scanners',
        'vuln,misconfig,secret',
        '--exit-code',
        '0',
        '--format',
        'json',
        '--skip-dirs',
        '.git,node_modules,.ssh,.aws,.gnupg,.local,.cache,.venv,venv,dist,build,target,vendor,coverage',
        root,
      ],
      root,
      'Trivy'
    );
    findings.push(...parseTrivy(root, report));
  }

  const slither = toolPath('Slither', tools, selected.slither);
  const solidityFiles = sourceFiles
    .filter((path) => path.toLowerCase().endsWith('.sol'))
    .map((path) => resolve(root, path));
  if (slither && solidityFiles.length > 25) {
    throw new Error('Slither is limited to 25 Solidity files per local scan');
  }
  if (slither) {
    for (const file of solidityFiles) {
      const report = runJson(
        slither,
        [file, '--json', '-', '--ignore-compile', '--fail-none'],
        root,
        'Slither'
      );
      findings.push(...parseSlither(root, report));
    }
  }

  const cargoAudit = toolPath('cargo-audit', tools, selected.cargoAudit);
  if (cargoAudit && sourceFiles.some((path) => path === 'Cargo.toml')) {
    const report = runJson(
      cargoAudit,
      ['audit', '--no-fetch', '--stale', '--json', '--file', resolve(root, 'Cargo.lock')],
      root,
      'cargo-audit',
      [0, 1]
    );
    findings.push(...parseCargoAudit(report));
  }

  return findings;
}
