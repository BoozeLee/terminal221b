#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { askAnthropic } from './anthropic.js';
import { applyApprovedPatch } from './patch.js';
import { collectWorkspaceContext } from './workspace.js';

const defaultModel = 'claude-sonnet-4-5-20250929';

function printHelp(): void {
  console.log(`Terminal221b local coding assistant

Usage:
  terminal221b ask [--workspace PATH] [--apply] PROMPT

Options:
  --workspace PATH  Limit repository context to this directory (default: cwd)
  --apply            Ask for a unified diff and require explicit approval to apply
  --help             Show this help

The CLI reads local text files and sends them with your prompt to Anthropic.
It never runs model-generated shell commands. Applying a patch requires typing APPLY.
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || !command) {
    printHelp();
    return;
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
