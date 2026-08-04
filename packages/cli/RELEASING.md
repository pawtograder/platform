# Packaging and releasing `@pawtograder/cli`

## How this package is put together

The CLI source lives at the repo root in [`cli/`](../../cli), not in this directory. It is shared by three consumers: `npm run cli` (via `cli/index.ts`), the unit tests under `tests/unit/cli-*.test.ts`, and this package (via `cli/bin.ts`). Nothing is copied or moved for publishing.

`build.mjs` bundles `cli/bin.ts` into `dist/pawtograder.js` with esbuild, which does two things a plain `tsc` build cannot:

- resolves the `@/cli/*` tsconfig path alias, which Node cannot resolve at runtime
- inlines our own modules into one file, so the package has no internal layout to keep stable

The three runtime dependencies (`yargs`, `yaml`, `csv-parse`) stay external and are declared in `package.json`. Inlining them would give a zero-dependency install, but `yargs` depends on `y18n`, which loads locale JSON from disk relative to `__dirname`; bundling that produces subtly broken help output.

### Two entry points

| Entry          | Used by                    | Loads `.env` |
| -------------- | -------------------------- | ------------ |
| `cli/index.ts` | `npm run cli` in this repo | yes          |
| `cli/bin.ts`   | the published binary       | no           |

Both delegate to `run()` in `cli/program.ts`, so the command wiring exists once. The published binary deliberately does not read `.env` files: the only environment variables the CLI consults are optional knobs, credentials live in `~/.pawtograder/credentials.json`, and a globally installed tool should not absorb the environment of whatever directory it is invoked from.

### Version

`--version` comes from `packages/cli/package.json`, injected at build time as `__CLI_VERSION__`. Running from source reports `0.0.0-dev`, so a source run is never mistaken for a release.

## Build and test locally

From the repo root:

```bash
npm run cli:build
```

That installs this package's dependencies, builds the bundle, and runs `smoke-test.mjs`, which executes the built binary and checks the shebang, that no `@/cli` alias survived bundling, that every external `require` is a declared dependency, that `dotenv` is absent, and that `--version`, `--help`, and a couple of nested subcommands work.

To verify an actual install rather than the working tree:

```bash
cd packages/cli && npm pack
mkdir -p /tmp/cli-check && cd /tmp/cli-check && npm init -y
npm install /path/to/pawtograder-cli-<version>.tgz
./node_modules/.bin/pawtograder --help
```

## Release

Releases run from CI ([`.github/workflows/publish-cli.yml`](../../.github/workflows/publish-cli.yml)) on a `cli-v*` tag:

```bash
npm --prefix packages/cli version patch     # or minor / major
git commit -am "chore(cli): release 0.1.1"
git tag cli-v0.1.1
git push origin HEAD --tags
```

The workflow refuses to publish if the tag version and `package.json` version disagree, then builds, smoke-tests, and runs `npm publish --access public`.

`workflow_dispatch` runs the same build and smoke test with `dry_run` enabled by default, which is a safe way to check the pipeline without releasing.

### One-time setup

- An npm organization named `pawtograder` (the package is scoped `@pawtograder/cli`). If that scope is unavailable, change `name` in `package.json`; nothing else depends on it.
- An `NPM_TOKEN` repository secret holding an npm **automation** token with publish rights on the scope. Automation tokens bypass 2FA prompts, which interactive tokens do not.
- `publishConfig.access` is already `public`. Without it, npm defaults scoped packages to restricted and the publish fails.

To publish by hand instead, from `packages/cli`: `npm ci && npm publish --access public` (`prepublishOnly` rebuilds and smoke-tests first).
