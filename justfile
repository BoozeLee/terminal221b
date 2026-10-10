# Terminal221b development commands

# Install all dependencies
install:
    npm ci

# Run all tests
test:
    npx vitest run
    cargo test --workspace --locked

# Lint
typecheck:
    npm run typecheck
    cargo build --workspace --locked

# Build
build:
    npm run build:cli
    cargo build --workspace --locked

# Lint
lint:
    npm run lint
    cargo fmt --check

# Format
fmt:
    cargo fmt

# Start the Expo dev server
start:
    npm start

# Run the CLI
cli:
    npm run cli

# Run the TUI
tui:
    npm run tui

# Clean build artifacts
clean:
    rm -rf node_modules dist target .expo coverage