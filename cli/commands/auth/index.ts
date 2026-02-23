/**
 * Auth command group
 *
 * Usage:
 *   pawtograder login
 *   pawtograder logout
 *   pawtograder whoami
 *
 * Note: Auth commands are registered at the top level in cli/index.ts
 */

import type { Argv } from "yargs";

export const command = "auth <action>";
export const describe = "Authentication (login, logout, whoami)";

export const builder = (yargs: Argv) => {
  return yargs.demandCommand(1, "Specify an action: login, logout, or whoami");
};

export const handler = () => {};
