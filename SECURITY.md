# Security

This is a client-side mobile app that sends a user-provided Anthropic API key directly to the Anthropic API. Native builds store the key with the operating system secure-storage API; chat history and non-secret configuration use AsyncStorage. Web builds keep the key in memory only. Do not distribute a build containing a developer-owned key.

To report a vulnerability, use GitHub private vulnerability reporting or a security advisory for this repository if enabled. Otherwise, contact the repository owner privately through GitHub. Do not post sensitive details in a public issue.

Dependency scans currently report advisories in the Expo toolchain; see the hiring-readiness pull request for the scan results and unresolved upgrade constraints.

A Gitleaks scan flagged a GitHub fine-grained-token-shaped value in an IDE state file in repository history. That file is absent from the current tree, but validity, revocation, and history cleanup are unverified. Treat the value as exposed and revoke it if it is still active.
