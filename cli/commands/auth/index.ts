/**
 * Auth command group (placeholder for yargs command module import)
 *
 * The actual login/logout/whoami commands are registered directly in cli/index.ts
 * because they predate the command-module pattern. This module exists so the
 * `import * as authCommand from "./commands/auth"` in index.ts resolves.
 */

import type { Argv } from "yargs";

export const command = "auth";
export const describe = false; // hidden command group
export const builder = (yargs: Argv) => yargs;
export const handler = () => {};
