import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export type ToolCategory = 'security' | 'solana/crypto';

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  purpose: string;
  documentation: string;
}

export interface ToolStatus extends ToolInfo {
  executable: string | null;
}

const catalog: Array<ToolInfo & { binary: string }> = [
  {
    name: 'Gitleaks',
    binary: 'gitleaks',
    category: 'security',
    purpose: 'Local repository secret detection',
    documentation: 'https://github.com/gitleaks/gitleaks',
  },
  {
    name: 'Semgrep',
    binary: 'semgrep',
    category: 'security',
    purpose: 'Static application security analysis',
    documentation: 'https://semgrep.dev/docs/',
  },
  {
    name: 'Trivy',
    binary: 'trivy',
    category: 'security',
    purpose: 'Local filesystem, dependency, and configuration scanning',
    documentation: 'https://trivy.dev/latest/docs/',
  },
  {
    name: 'Bandit',
    binary: 'bandit',
    category: 'security',
    purpose: 'Python source security linting',
    documentation: 'https://bandit.readthedocs.io/',
  },
  {
    name: 'Slither',
    binary: 'slither',
    category: 'security',
    purpose: 'Solidity static analysis',
    documentation: 'https://github.com/crytic/slither',
  },
  {
    name: 'cargo-audit',
    binary: 'cargo-audit',
    category: 'security',
    purpose: 'Rust dependency advisory checks',
    documentation: 'https://github.com/rustsec/rustsec/tree/main/cargo-audit',
  },
  {
    name: 'Solana CLI',
    binary: 'solana',
    category: 'solana/crypto',
    purpose: 'Solana cluster and local-validator development',
    documentation: 'https://solana.com/docs/intro/installation',
  },
  {
    name: 'Anchor CLI',
    binary: 'anchor',
    category: 'solana/crypto',
    purpose: 'Solana program development with Anchor',
    documentation: 'https://www.anchor-lang.com/docs/installation',
  },
  {
    name: 'Anchor Version Manager',
    binary: 'avm',
    category: 'solana/crypto',
    purpose: 'Install and select Anchor CLI versions',
    documentation: 'https://www.anchor-lang.com/docs/installation',
  },
  {
    name: 'Foundry forge',
    binary: 'forge',
    category: 'solana/crypto',
    purpose: 'Local EVM contract build and test',
    documentation: 'https://book.getfoundry.sh/getting-started/installation',
  },
  {
    name: 'Foundry cast',
    binary: 'cast',
    category: 'solana/crypto',
    purpose: 'EVM RPC and ABI utility',
    documentation: 'https://book.getfoundry.sh/cast/',
  },
  {
    name: 'Solidity compiler',
    binary: 'solc',
    category: 'solana/crypto',
    purpose: 'Compile Solidity contracts',
    documentation: 'https://docs.soliditylang.org/en/latest/installing-solidity.html',
  },
];

async function findExecutable(binary: string, pathValue: string): Promise<string | null> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function discoverTools(
  pathValue = process.env.PATH ?? ''
): Promise<ToolStatus[]> {
  return Promise.all(
    catalog.map(async ({ binary, ...tool }) => ({
      ...tool,
      executable: await findExecutable(binary, pathValue),
    }))
  );
}
