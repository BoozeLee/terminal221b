# terminal221b-cli

The Terminal221b coding assistant as a local-first command line tool.

Runs on your machine. Reads and writes files in a workspace you choose. Talks to a model provider
only when you ask it to, and says so when it does.

## Install

From a GitHub Release — verifies the sha256 before extracting:

```sh
curl -fsSL https://github.com/BoozeLee/terminal221b/releases/latest/download/install.sh | bash
```

Or with npm:

```sh
npm install -g terminal221b-cli
```

Requires **Node.js 22 or newer**. There is no per-platform download: the release is one
text tarball, because the CLI has no runtime dependencies and ships no compiled artifacts.

The installer refuses to run as root, prints every path before writing to it, and aborts rather
than extracting a download whose checksum does not match. If you would rather read it first:

```sh
curl -fsSL https://github.com/BoozeLee/terminal221b/releases/latest/download/install.sh
```

## Use

```sh
terminal221b                       # start a session
terminal221b --help                # full command list
terminal221b tools                 # the tools the assistant may call
terminal221b tui                   # the terminal UI
terminal221b security scan         # static analysis over the workspace
```

Options: `--workspace PATH`, `--apply` (write approved changes to disk), `--role NAME`.

There is no `--version` flag; the version is the `version` field of this package.

The provider and credentials are read from your own environment. This package bundles no third-party
runtime dependencies — everything it imports at runtime is a Node.js built-in.

## What ships in the package

| Path | Why |
|---|---|
| `dist/` | the compiled CLI, `dist/cli.js` is the `terminal221b` binary |
| `resources/provider-boundary.json` | the policy the assistant is held to |
| `resources/omarchy-toolchain-plan.sh` | toolchain plan for the Omarchy setup path |
| `resources/semgrep.yml` | rules for the static analysis the assistant runs |

Sources, tests and TypeScript configuration are deliberately **not** published. The contents of
every published tarball are asserted by a gate in CI; see
`docs/TERMINAL221B-GATES.md` in the repository.

## Licence

**AGPL-3.0-only.** See [LICENSE](./LICENSE).

## Repository

<https://github.com/BoozeLee/terminal221b>
