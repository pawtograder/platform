/**
 * Command handler type definition for CLI.
 * Params are always Record<string, unknown> at runtime (from JSON body).
 *
 * Most commands return a CLIResponse object that the dispatcher serializes to
 * JSON. A small set of commands (currently: assessment.export) instead need to
 * stream a large multi-section payload back to the CLI without buffering the
 * whole response in memory on either side. Those commands set `stream: true`
 * and provide a `streamHandler` that writes directly to the HTTP response
 * body. The dispatcher gives them a fully constructed Response so they own
 * status, headers, and body.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse } from "../types.ts";

export type CommandHandler = (ctx: MCPAuthContext, params: Record<string, unknown>) => Promise<CLIResponse>;

export type StreamCommandHandler = (
  ctx: MCPAuthContext,
  params: Record<string, unknown>,
  request: Request
) => Promise<Response>;

/** Every CLI command must declare authorization: OAuth scopes or explicitly public (no scope check). */
export type CLICommandRequiredScope = "cli:read" | "cli:write" | "public";

export interface CommandDefinition<TParams = Record<string, unknown>> {
  name: string;
  requiredScope: CLICommandRequiredScope;
  handler: CommandHandler;
}

export interface StreamCommandDefinition {
  name: string;
  requiredScope: CLICommandRequiredScope;
  stream: true;
  handler: StreamCommandHandler;
}

export type AnyCommandDefinition = CommandDefinition | StreamCommandDefinition;

export function isStreamCommand(def: AnyCommandDefinition): def is StreamCommandDefinition {
  return (def as StreamCommandDefinition).stream === true;
}
