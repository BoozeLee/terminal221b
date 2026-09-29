#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { runLocalAnalyzers } from './analyzers.js';
import { askAnthropic } from './anthropic.js';
import { applyApprovedPatch } from './patch.js';
import { scanLocalWorkspace } from './security.js';
import { loadBountyScope } from './scope.js';
import { discoverTools } from './tools.js';
import { collectWorkspaceContext } from './workspace.js';

const defaultModel = 'claude-sonnet-4-5-20250929';

function printHelp(): void {
  console.log(`Terminal221b local coding assistant

Usage:
  terminal221b ask [--workspace PATH] [--apply] PROMPT
  terminal221b security scan [--workspace PATH] [--with-gitleaks] [--with-bandit]
  terminal221b scope validate PATH
  terminal221b tools
  terminal221b setup omarchy --dry-run

Options:
  --workspace PATH  Limit repository context to this directory (default: cwd)
  --apply            Ask for a unified diff and require explicit approval to apply
  --help             Show this help

The CLI reads local text files and sends them with your prompt to Anthropic.
It never runs model-generated shell commands. Applying a patch requires typing APPLY.
Security scans inspect local files only; optional scanners run only when explicitly selected.
Scope validation never sends target requests.
Omarchy setup prints a package plan only and never installs software.
`);
}

function parseArgs(args: string[]): {
  workspace: string;
  prompt: string;
  apply: boolean;
} {
  let workspace = process.cwd();
  let apply = false;
  const prompt: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--workspace') {
      const value = args[index + 1];
      if (!value) throw new Error('--workspace requires a directory path');
      workspace = resolve(value);
      index += 1;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      prompt.push(arg);
    }
  }

  const value = prompt.join(' ').trim();
  if (!value) throw new Error('Provide a prompt after the ask command');
  return { workspace, prompt: value, apply };
}

async function confirmPatch(paths: string[], patch: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Patch approval requires an interactive terminal');
  }

  console.log(`\nPatch targets (${paths.length}):`);
  for (const path of paths) console.log(`  ${path}`);
  console.log('\nProposed diff:\n');
  console.log(patch);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    return (await terminal.question('Type APPLY to write these changes: ')) === 'APPLY';
  } finally {
    terminal.close();
  }
}

function workspaceOption(args: string[]): string {
  let workspace = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--workspace') continue;
    const value = args[index + 1];
    if (!value) throw new Error('--workspace requires a directory path');
    workspace = resolve(value);
    index += 1;
  }
  return workspace;
}

async function showTools(): Promise<void> {
  const tools = await discoverTools();
  for (const category of ['security', 'solana/crypto'] as const) {
    console.log(`\n${category}`);
    for (const tool of tools.filter((entry) => entry.category === category)) {
      const status = tool.executable ?? 'not found';
      console.log(`  ${tool.name}: ${status}`);
      console.log(`    ${tool.purpose} (${tool.documentation})`);
    }
  }
  console.log('\nDiscovery checks PATH only; it does not execute or install tools.');
}

async function runSecurityScan(args: string[]): Promise<void> {
  const workspace = workspaceOption(args);
  const selected = {
    gitleaks: args.includes('--with-gitleaks'),
    bandit: args.includes('--with-bandit'),
  };
  const result = await scanLocalWorkspace(workspace);
  const tools = await discoverTools();
  result.findings.push(
    ...runLocalAnalyzers(result.root, result.sourceFiles, tools, selected)
  );
  console.log(
    `Local scan: ${result.root} (${result.filesScanned} files, ${result.bytesScanned} bytes)`
  );
  console.log('Local analyzers and heuristic triage only. No network targets are contacted.');
  console.log(
    `Selected analyzers: ${[selected.gitleaks && 'Gitleaks', selected.bandit && 'Bandit'].filter(Boolean).join(', ') || 'built-in heuristics only'}`
  );
  for (const finding of result.findings) {
    console.log(
      `${finding.file}:${finding.line} [${finding.severity}] ${finding.rule}: ${finding.message}`
    );
  }
  if (result.truncated) {
    console.warn('Scan limits reached; results are incomplete.');
  }
  if (result.findings.length === 0) console.log('No configured pattern matches.');
  if (result.findings.some((finding) => finding.severity === 'high')) process.exitCode = 1;
}

async function validateScope(args: string[]): Promise<void> {
  const path = args[0];
  if (!path || args.length !== 1) {
    throw new Error('Usage: terminal221b scope validate PATH');
  }
  const manifest = await loadBountyScope(path);
  console.log(`Validated scope metadata for ${manifest.program}.`);
  console.log(`Policy: ${manifest.policyUrl}`);
  console.log(`In-scope entries: ${manifest.inScope.length}`);
  console.log(`Out-of-scope entries: ${manifest.outOfScope?.length ?? 0}`);
  console.log('Validation only; no target requests are made.');
}

async function printOmarchyPlan(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== '--dry-run') {
    throw new Error('Usage: terminal221b setup omarchy --dry-run');
  }
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const scriptPath = fileURLToPath(
    new URL('../resources/omarchy-toolchain-plan.sh', import.meta.url)
  );
  const result = spawnSync('bash', [scriptPath, '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    maxBuffer: 100_000,
    timeout: 10_000,
  });
  if (result.error) throw new Error(`Could not run Omarchy preflight: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Omarchy preflight failed (exit ${result.status}); stderr was suppressed.`);
  }
  process.stdout.write(result.stdout);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || !command) {
    printHelp();
    return;
  }
  if (command === 'tools') return showTools();
  if (command === 'security') {
    if (args[0] !== 'scan') throw new Error('Usage: terminal221b security scan [--workspace PATH]');
    return runSecurityScan(args.slice(1));
  }
  if (command === 'scope') {
    if (args[0] !== 'validate') throw new Error('Usage: terminal221b scope validate PATH');
    return validateScope(args.slice(1));
  }
  if (command === 'setup') {
    if (args[0] !== 'omarchy') {
      throw new Error('Usage: terminal221b setup omarchy --dry-run');
    }
    return printOmarchyPlan(args.slice(1));
  }
  if (command !== 'ask') throw new Error(`Unknown command: ${command}`);

  const options = parseArgs(args);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY in your shell before using ask');

  const context = await collectWorkspaceContext(options.workspace);
  const contextText = context.files
    .map(({ path, content }) => `--- ${path} ---\n${content}`)
    .join('\n\n');
  console.error(
    `Workspace: ${context.root} (${context.files.length} files, ${context.totalBytes} bytes)`
  );

  const instruction = options.apply
    ? `${options.prompt}\nReturn only a unified git diff. Do not include explanations or commands.`
    : options.prompt;
  const answer = await askAnthropic({
    apiKey,
    model: process.env.TERMINAL221B_MODEL ?? defaultModel,
    prompt: instruction,
    context: contextText || '(No supported text files found in the workspace.)',
  });

  if (!options.apply) {
    console.log(answer);
    return;
  }

  const match = answer.match(/```diff\s*\n([\s\S]*?)```/);
  const patch = (match?.[1] ?? answer).trim();
  const paths = await applyApprovedPatch(context.root, patch, confirmPatch);
  console.log(`Applied approved changes to ${paths.length} workspace paths.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown CLI error';
  console.error(`terminal221b: ${message}`);
  process.exitCode = 1;
});
