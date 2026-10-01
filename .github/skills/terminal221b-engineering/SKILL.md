---
name: terminal221b-engineering
description: Engineer Terminal221b across its Expo/React Native client, TypeScript CLI, and Rust Ratatui/Crossterm TUI. Use for product architecture, feature work, agent workflows, coding tools, quality, and security in this repository.
---

# Terminal221b engineering

## Source of truth

For Terminal221b work, read and follow `docs/TERMINAL221B-AGENTIC-ENGINEERING.md` from the checked-out repository root. Do not resolve this path relative to the skill installation directory. Verify current source, manifests, tests, worktree, and instructions before relying on its architecture snapshot. Code is authoritative; do not present roadmap goals as implemented features. If no Terminal221b checkout is available, state that limitation rather than inventing current project details.

## Working rules

- Preserve boundaries between the Expo/React Native app, TypeScript CLI, and Rust shell TUI unless the task explicitly requires a change.
- Ship small, complete, tested slices. Use a written plan for cross-surface, risky, or architecture-level work; do not make routine work wait on unnecessary process.
- Keep pure logic testable and filesystem/provider work off the TUI draw loop. Keep errors visible and preserve security boundaries.
- Discover Copilot CLI skills/plugins and current CLI help before relying on capabilities. Use relevant installed tools and skills; never claim a plugin is present unless it is listed. Do not install external plugins or alter global configuration without a concrete need and operator approval.
- Treat Analyst, Artist, and Engineer as role seeds, not independent agents, unless real orchestration is implemented and tested.
- Do not request, print, or commit secrets; do not claim local-only handling when data is sent to a provider. Preserve human review for patches and consequential external actions.
- Do not add trading, wallet custody, blockchain transactions, bounty-target testing/submission, or paid feature gates under this skill.
- Inspect package scripts and CI before running checks. Run the narrowest relevant tests, then report only checks actually completed.
- Do not push, open or edit PRs, merge, publish, or change repository settings unless explicitly asked.

For TUI-specific implementation details and Rust checks, see `.github/skills/terminal221b-tui-engineering/SKILL.md` in the checked-out repository.
