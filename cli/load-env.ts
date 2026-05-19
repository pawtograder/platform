/**
 * Load env files from the project root when running the CLI via `npm run cli`.
 * Precedence for each key: shell environment, then .env.local, then .env (dotenv
 * default: never overwrites an existing process.env value).
 */
import { config } from "dotenv";
import { resolve } from "node:path";

const root = process.cwd();

config({ path: resolve(root, ".env.local") });
config({ path: resolve(root, ".env") });
