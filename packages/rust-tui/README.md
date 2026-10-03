# terminal221b-tui

The Terminal221b coding assistant as a terminal UI, in Rust.

Runs on your machine, against a workspace you choose. Renders through `ratatui`, reads input
through `crossterm`, and talks to a model provider only when asked to.

## Install

```sh
cargo install terminal221b-tui
```

Requires **Rust 1.88 or newer**.

## Use

```sh
terminal221b-tui
```

Point it at a provider and credentials through your own environment. Nothing is bundled and no
credential is read from a file this crate ships.

## What this crate is

A single binary. There is no library target and therefore no public Rust API to depend on — which
also means there is no semver surface for `cargo-semver-checks` to check. That is a deliberate
property of the crate, not an oversight; it is recorded in the gate register.

## Licence

**AGPL-3.0-only.**

## Repository

<https://github.com/BoozeLee/terminal221b>
