#!/usr/bin/env npx tsx
/**
 * Pawtograder CLI — in-repo entry point.
 *
 * Loads `.env.local` / `.env` from the working directory before running, which
 * is why `npm run cli` picks up repo-local settings. The published binary
 * (`bin.ts`) deliberately skips that: a globally installed CLI should not absorb
 * the environment of whatever directory it happens to be invoked from.
 *
 * Usage:
 *   npx tsx cli/index.ts <command> [options]
 *   npm run cli -- <command> [options]
 *
 * Examples:
 *   npm run cli -- classes list
 *   npm run cli -- assignments copy --source-class cs3500-fall-2025 --target-class cs3500-spring-2026 --all
 */

import "./load-env";
import { run } from "./program";

run();
