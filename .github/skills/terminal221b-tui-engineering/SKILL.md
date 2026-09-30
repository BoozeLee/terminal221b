---
name: terminal221b-tui-engineering
description: Develop and review Terminal221b's Rust terminal interface with Ratatui and Crossterm. Use when changing packages/rust-tui, terminal interaction, session storage, workspace context, or its architecture.
---

# Terminal221b TUI engineering

## Project boundaries

- Keep the shell TUI in Rust with Ratatui/Crossterm; keep mobile and TypeScript
  CLI behavior unchanged unless the task explicitly asks for it.
- Keep terminal rendering and input state deterministic and unit-testable.
- Keep blocking provider, filesystem, and scanner work out of the draw loop.
- Workspace content is untrusted input. Preserve hidden-file, symlink, size,
  secret-file, and explicit patch-approval guards.
- Never execute model-generated commands, contact bounty targets, sign or send
  blockchain transactions, or request wallet secrets.
- Do not describe role prompts as independent agents unless actual orchestration
  exists. Do not claim data stays local when it is sent to a provider.
- Preserve the repository's current license. GitHub Sponsors is voluntary;
  do not add paid gates, payment processing, or unsupported revenue claims.

## Change workflow

1. Read the TUI code, package manifest, README, and current worktree status.
2. Keep changes within the task's stated scope; avoid adding a dependency for a
   small UI feature.
3. Put pure state transitions and parsing in focused, testable functions or
   modules. Collect terminal events centrally and dispatch to focused handlers.
4. Keep provider and filesystem errors visible; never turn failures into
   success-shaped output.
5. Update README when terminal commands, storage, or data-disclosure behavior
   changes.
6. Run from the repository root:

   ```sh
   cargo fmt --all -- --check
   cargo test --workspace --locked
   cargo clippy --workspace --all-targets --locked -- -D warnings
   cargo build --workspace --locked
   ```

7. If dependencies changed, update and verify `Cargo.lock`; otherwise leave it
   unchanged. Do not push, edit PRs, or install host packages unless the task
   explicitly authorizes it.

