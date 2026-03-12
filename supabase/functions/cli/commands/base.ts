/**
 * Command handler type definition for CLI.
 * Params are always Record<string, unknown> at runtime (from JSON body).
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse } from "../types.ts";

export type CommandHandler = (ctx: MCPAuthContext, params: Record<string, unknown>) => Promise<CLIResponse>;

export interface CommandDefinition<TParams = Record<string, unknown>> {
  name: string;
  /** When undefined, no scope check is performed (e.g. token.info) */
  requiredScope?: "cli:read" | "cli:write";
  handler: CommandHandler;
}
