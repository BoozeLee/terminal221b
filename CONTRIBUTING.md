# Contributing

Use Node.js 22 and npm. Install the locked dependencies with `npm ci`, then run:

```sh
npm run lint
npm test
npm run typecheck
npm run build
```

Keep pull requests focused, add deterministic tests for changed logic, and document checks that require a device or API credential. Do not commit API keys or place them in `EXPO_PUBLIC_*` variables; client-exposed values are not secrets.

The repository is proprietary. Do not redistribute or reuse it without permission under the terms in [LICENSE](LICENSE).
