# Contributing

Use a full clone: generators read Git history, so shallow clones are not supported.

Requirements:

- Node.js 22 and npm.
- Rust via rustup, following [rust-toolchain.toml](rust-toolchain.toml) and the requirements in [Cargo.toml](src-tauri/Cargo.toml).
- Python 3.11 or newer for `scripts/release-check.sh`.
- On macOS, Xcode Command Line Tools.

```sh
git clone https://github.com/hugrverk/riggverk.git
cd riggverk
npm ci
npm run tauri dev
```

`npm run dev` starts the browser-only frontend. See [the release guide](docs/RELEASE.md) for verification limits and native smoke checks.

## Making changes

Canonical bundled sources live in `resources/default-workspace/`. Edit sources, then refresh generated files:

```sh
python3 scripts/generate.py write
```

Follow the [skill catalog and standards](resources/default-workspace/docs/SKILLS.md). Be conservative with new bundled skills; prefer optional skill packs (coming) for specialized content.

After dependency changes, regenerate and commit `THIRD_PARTY_NOTICES.md`:

```sh
python3 scripts/third-party-notices.py
python3 scripts/third-party-notices.py --check
```

This requires installed npm dependencies and Cargo metadata for the locked Rust graph.

## Before a pull request

`./scripts/release-check.sh` is the merge gate. Run it from the repository root and require `release-check passed` before merging.

Use English commit subjects in the form `<type>(<scope>): <subject>`, imperative and at most 72 characters. Types: `feat`, `fix`, `refactor`, `chore`, `docs`. Keep each commit to one logical change.

Releases use CalVer `YYYY.MM.N`: year, month (without a leading zero), and a counter within that month.

## Conduct

Taking part means following the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

No CLA is required. Inbound equals outbound: contributions are accepted under the same [MIT license](LICENSE) as the project.
