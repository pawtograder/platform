/**
 * Load env files from the project root when running the CLI via `npm run cli`.
 * Does not override variables already set in the shell.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

const root = process.cwd();

config({ path: resolve(root, ".env") });
config({ path: resolve(root, ".env.local"), override: true });
