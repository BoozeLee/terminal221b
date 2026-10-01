/**
 * System prompts as an enumerable profile with named clauses.
 *
 * The problem this fixes is drift, and the drift was measured. The crypto
 * prohibitions were a system prompt in the Rust TUI and user text in the CLI, so
 * the CLI's copy was the weaker of the two — and it was the copy anyone running
 * `terminal221b crypto ask` actually got. The two non-crypto system strings also
 * disagreed on wording. Three implementations, one rule, and no shared test.
 *
 * The fix is one clause vocabulary. Every rule in the "Security, sovereignty,
 * and financial boundaries" section of `docs/TERMINAL221B-AGENTIC-ENGINEERING.md`
 * gets a clause name here, so a profile is auditable by reading a list of names
 * rather than by reading prose and hoping. `packages/cli/resources/provider-boundary.json`
 * is the single source of truth for both surfaces, and each side has a test that
 * fails if a clause exists on one and not the other.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYSTEM_PROFILES = ['coding', 'crypto', 'analyst'] as const;
export type SystemProfile = (typeof SYSTEM_PROFILES)[number];

/**
 * The role vocabulary, mirroring `AGENT_ROLES` in `case.ts`. Duplicated rather
 * than imported because `AGENT_ROLES` is not exported from there and `case.ts` is
 * outside this slice's write scope; `system-prompt.test.ts` fails if the two ever
 * drift, so the duplicate cannot quietly become a second role vocabulary.
 */
export const AGENT_ROLES = ['scout', 'analyst', 'engineer', 'artist', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const CLAUSES = [
  'identity',
  'untrusted_repository_text',
  'no_command_execution',
  'no_false_claims_of_change',
  'patch_format',
  'no_secrets_requested_or_transmitted',
  'no_public_env_secrets',
  'disclose_provider_transmission',
  'no_remote_target_testing',
  'no_remote_target_capability',
  'no_report_submission',
  'no_personalized_investment_advice',
  'no_trades_or_transactions',
  'no_wallet_custody_or_signing',
  'no_wallet_secrets',
  'separate_facts_from_assumptions',
  'do_not_simulate_unimplemented',
  'human_is_final_authority',
  'no_patch_proposals',
] as const;

export type Clause = (typeof CLAUSES)[number];

interface BoundaryFile {
  version: 1;
  note: string;
  clauseOrder: Clause[];
  clauses: Record<Clause, string>;
  profiles: Record<SystemProfile, Clause[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_PATH = join(HERE, '..', 'resources', 'provider-boundary.json');

let cached: BoundaryFile | undefined;

export function boundaryFile(): BoundaryFile {
  if (cached === undefined) {
    cached = JSON.parse(readFileSync(BOUNDARY_PATH, 'utf8')) as BoundaryFile;
  }
  return cached;
}

/** The authoritative path, so the Rust side and this side can be pointed at one file. */
export const BOUNDARY_FILE_PATH = BOUNDARY_PATH;

export type SystemPrompt = string & { readonly __profile: SystemProfile };

/**
 * Renders a profile. Unknown profile or unknown clause is a thrown error rather
 * than a silently empty prompt, because a prompt that lost a prohibition is
 * worse than no prompt.
 */
export function renderSystemPrompt(profile: SystemProfile): SystemPrompt {
  const file = boundaryFile();
  const clauses = file.profiles[profile];
  if (clauses === undefined) {
    throw new Error(`unknown system profile: ${profile}`);
  }
  for (const clause of clauses) {
    if (file.clauses[clause] === undefined) {
      throw new Error(`profile ${profile} names a clause with no text: ${clause}`);
    }
  }
  const text = file.clauseOrder
    .filter((clause) => clauses.includes(clause))
    .map((clause) => file.clauses[clause])
    .join(' ');
  return text as SystemPrompt;
}

export function clausesOf(profile: SystemProfile): Clause[] {
  return boundaryFile().profiles[profile].slice();
}

export function textOf(clause: Clause): string {
  return boundaryFile().clauses[clause];
}

/**
 * The clause set a profile must never be missing, regardless of profile. Every
 * one of these is in the "a prompt may never" list. Used by the test that proves
 * no profile can quietly drop a prohibition.
 */
export function universalClauses(): Clause[] {
  return [
    'no_secrets_requested_or_transmitted',
    'no_public_env_secrets',
    'no_command_execution',
    'do_not_simulate_unimplemented',
    'human_is_final_authority',
  ];
}

/**
 * Which system profile each agent role selects.
 *
 * `Record<AgentRole, SystemProfile>` is deliberate: adding a sixth role to
 * `AGENT_ROLES` without deciding what it runs under is a compile error here, so a
 * role cannot become a label again by omission. Only `analyst` selects its own
 * profile. The other four are still labels and still run the coding profile,
 * which is exactly what they ran before this table existed.
 */
export const ROLE_PROFILES: Record<AgentRole, SystemProfile> = {
  scout: 'coding',
  analyst: 'analyst',
  engineer: 'coding',
  artist: 'coding',
  reviewer: 'coding',
};

/**
 * The role selects the profile. This is the seam that makes `TaskContract.role`
 * more than a label: a role that is not consulted here cannot change the system
 * text, and a profile that renders is reachable.
 *
 * `undefined` is not a role and maps to `coding`, so an ask with no `--role`
 * resolves to the same profile it always did.
 */
export function profileForRole(role: AgentRole | undefined): SystemProfile {
  return role === undefined ? 'coding' : ROLE_PROFILES[role];
}
