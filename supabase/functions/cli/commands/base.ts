/**
 * Command handler type definition for CLI.
 * Params are always Record<string, unknown> at runtime (from JSON body).
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse } from "../types.ts";

export type CommandHandler = (ctx: MCPAuthContext, params: Record<string, unknown>) => Promise<CLIResponse>;

/** Every CLI command must declare authorization: OAuth scopes or explicitly public (no scope check). */
export type CLICommandRequiredScope = "cli:read" | "cli:write" | "public";

export interface CommandDefinition<TParams = Record<string, unknown>> {
  name: string;
  requiredScope: CLICommandRequiredScope;
  handler: CommandHandler;
}
