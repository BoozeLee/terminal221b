# Terminal TUI architecture

## Decision

Keep the shell interface in Rust with Ratatui and Crossterm. Terminal221b
already has a Rust TUI package and a local CLI toolchain; replacing it with a
second TypeScript or Go terminal app would split operator workflows and add
another runtime to maintain. This is a repository-specific fit, not a claim
that one language is best for every coding agent.

The current interaction model is a single terminal event loop that updates
application state and redraws Ratatui frames. Pure prompt editing lives in
`packages/rust-tui/src/prompt.rs`; bounded workspace selection and the
content-free `/context` preview live in `workspace.rs`; local transcript I/O
lives in `session.rs`. Provider requests and workspace previews run on worker
threads and return through a channel. Keep I/O and provider work off the UI
loop. Continue extracting actions and view components into independently
testable modules as features justify it. Prefer a centralized event collector
that dispatches events to focused handlers over a separate event loop in each
screen.

## Reference comparison

The comparison uses public GitHub language metadata and official package
manifests/documentation. It does not copy or depend on reference source.

| Direction | Observed fit | Trade-off for Terminal221b |
| --- | --- | --- |
| Rust + Ratatui/Crossterm | Codex's TUI manifest uses Ratatui and Crossterm; this repository already uses the same pair. | Selected. Strong fit for a native terminal binary and the existing Rust package; keep async work and pure state transitions separate. |
| TypeScript + OpenTUI | OpenCode's package manifest declares OpenTUI and Solid. OpenCode's repository language metadata is primarily TypeScript. | Familiar language for the app and CLI, but a second TUI implementation would duplicate the current Rust interface. |
| TypeScript + Ink/React | Gemini CLI's manifest uses Ink and React; its repository language metadata is primarily TypeScript. | Reuses the wider TypeScript ecosystem, but introduces a second terminal UI framework/runtime in this product. |
| Go + Bubble Tea | Bubble Tea's official module is Go and documents a model/update/view program style. | Clear event/state separation and a useful standalone CLI option, but a rewrite would add a third implementation language without solving a current limitation. |
| Python + Textual | Textual documents reactive widgets and message-driven interaction. | Useful for rapid prototypes and Python-centered workflows; less aligned with the existing Rust CLI binary and package. |
| Direct Crossterm | Crossterm provides terminal control and input; Ratatui is already the rendering/layout layer here. | Maximum low-level control, with extra bespoke rendering work that does not address a demonstrated need. |

## Multi-criteria decision

These are qualitative judgments for this repository, not language benchmarks.
“Economic leverage” means reduced duplicate maintenance or improved operator
control; no revenue is implied.

| Direction | Novelty | Operator delight | Feasibility here | Economic leverage | Sovereignty | New ground |
| --- | --- | --- | --- | --- | --- | --- |
| Rust + Ratatui | Moderate | High potential with focused components | High; already built and tested | Moderate; avoids a second shell implementation | High; local binary and local preflight | Moderate; compose existing CLI, scanners, and deliberate provider use |
| TypeScript + OpenTUI | Moderate | High precedent in OpenCode | Moderate; new runtime/UI layer | Low to moderate; duplicates the Rust shell | Moderate; runtime/provider still configurable | Moderate; easier shared TS ecosystem integration |
| TypeScript + Ink | Low to moderate | High for React-familiar contributors | Moderate; new renderer/package | Low to moderate; overlaps both TS CLI and Rust TUI | Moderate | Low to moderate; mature pattern, less repo-specific |
| Go + Bubble Tea | Moderate | High potential from clear model/update/view flow | Low; language and application rewrite | Low; another implementation to maintain | High after standalone distribution | Moderate; clean event model, not a new product loop |
| Python + Textual | Moderate | High for data-oriented prototypes | Moderate for a prototype, low for the shipped Rust shell | Low until it removes measurable workflow work | Moderate; Python runtime/tool dependencies remain | Moderate; useful for analyzer exploration |
| Direct Crossterm | Low | Low to moderate until widgets are rebuilt | Low; duplicates current rendering primitives | Low | High | Low; lower abstraction, not a new workflow |

The strongest two alternatives to the selected path are TypeScript/OpenTUI and
Go/Bubble Tea. OpenTUI is the better option only if the app and CLI converge on
a shared TypeScript runtime; no such consolidation requirement exists today.
Bubble Tea is attractive for a fresh single-binary CLI, but would replace
working Rust components without a measured operational gain. Stay with
Ratatui; spend engineering effort on a context preflight, robust input, session
control, and focused app modules instead of switching frameworks.

Ratatui's event-handling guidance describes centralized event collection with
dispatch into focused functions/modules as a way to keep a larger application
manageable. Its component architecture keeps each component's state, event
handling, update, and rendering together. Apply those as incremental design
patterns; do not copy code or attempt a broad rewrite.

## Evidence and limits

- GitHub's language endpoint was queried for
  `anomalyco/opencode`, `google-gemini/gemini-cli`, `openai/codex`, and
  `charmbracelet/bubbletea`.
- Read official manifests only for OpenCode's TUI dependencies, Gemini CLI's
  Ink/React dependencies, Codex's TUI Ratatui/Crossterm dependencies, and
  Bubble Tea's module identity.
- Anthropic's public `anthropics/claude-code` repository metadata lists
  TypeScript, Python, and Shell, but no SPDX license metadata. Those totals do
  not prove which language implements its TUI. Its source was not inspected.
- Repository language totals indicate file volume, not performance, UX quality,
  developer productivity, or user adoption.

Sources:

- [OpenCode repository](https://github.com/anomalyco/opencode)
- [Gemini CLI repository](https://github.com/google-gemini/gemini-cli)
- [Codex TUI package](https://github.com/openai/codex/tree/main/codex-rs/tui)
- [Bubble Tea repository](https://github.com/charmbracelet/bubbletea)
- [Claude Code repository metadata](https://github.com/anthropics/claude-code)
- [Ratatui event handling](https://ratatui.rs/concepts/event-handling/)
- [Ratatui component architecture](https://ratatui.rs/concepts/application-patterns/component-architecture/)
- [OpenCode TUI documentation](https://opencode.ai/docs/tui/)
- [Textual reactivity](https://textual.textualize.io/guide/reactivity/)
- [Copilot CLI project skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Copilot CLI plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)

## Product and sustainability boundaries

GitHub Sponsors remains voluntary, with no paid or gated core features in this
workstream. The app has no verified adoption, revenue, or cost data, so no
pricing or return claims are justified. Do not add Stripe, trading, wallet
custody, or bounty submission to improve the TUI. Measure real operator use,
provider spend, support burden, and contributor demand before considering any
new funding mechanism.

Success evidence for this architecture is observable without invented
benchmarks: context selection is deterministic and bounded; `/context` reports
paths and byte counts without showing contents or making a provider request;
session files exclude provider context; UI edits are covered by pure tests;
provider/filesystem work stays off the rendering loop; and all acceptance
commands pass. Longer-term, evaluate actual operator task completion, observed
provider costs from the provider's own usage records, failure rates, and
contributor requests before expanding roles or proposing additional support
models.

Self-critique: Ratatui does not supply the architecture automatically, and a
single event loop can still become a monolith. The current renderer and
application coordinator are still in `main.rs`; this change modularizes only
prompt editing, session persistence, and workspace selection. A future
agent-role system remains unimplemented until its prompt/evaluation contract
can be designed and measured.
