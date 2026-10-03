# Contributing

Use Node.js 22 and npm. Install the locked dependencies with `npm ci`, then run:

```sh
npm run lint
npm test
npm run typecheck
npm run build
```

Keep pull requests focused, add deterministic tests for changed logic, and document checks that require a device or API credential. Do not commit API keys or place them in `EXPO_PUBLIC_*` variables; client-exposed values are not secrets.

The Rust package has its own checks, which CI does not run yet:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

`cargo fmt` and `cargo clippy` are described in `docs/TERMINAL221B-ENGINEERING-GUIDE.md` and were not enforced by any workflow before this file said so.

Terminal221b is licensed under the GNU Affero General Public License v3.0 only. Contributions are accepted under those terms; see [LICENSE](LICENSE). If you submit a contribution you confirm you have the right to license it that way.
