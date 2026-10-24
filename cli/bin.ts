/**
 * Pawtograder CLI — published binary entry point.
 *
 * Bundled by `packages/cli` into a single file with a `#!/usr/bin/env node`
 * banner. Unlike the in-repo `index.ts`, this does not read `.env` files: the
 * only environment variables the CLI consults are optional knobs (`DEBUG`,
 * `PAWTOGRADER_VERBOSE`, `PAWTOGRADER_HTTP_TIMEOUT_MS`), and credentials live in
 * `~/.pawtograder/credentials.json`, so silently loading a stray `.env` from the
 * current directory would be surprising rather than helpful.
 */

import { run } from "./program";

run();
