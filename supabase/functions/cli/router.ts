/**
 * Command registration and dispatch for CLI.
 *
 * Two command shapes are supported:
 *   - JSON commands return a CLIResponse; the dispatcher JSON-stringifies it.
 *   - Stream commands return a Response directly (used for NDJSON streaming
 *     of large multi-section payloads like assessment.export).
 */

import type { AnyCommandDefinition, CommandDefinition, StreamCommandDefinition } from "./commands/base.ts";
import { isStreamCommand } from "./commands/base.ts";
import { requireScope } from "../_shared/MCPAuth.ts";
import type { MCPAuthContext } from "../_shared/MCPAuth.ts";
import type { CLIRequest, CLIResponse } from "./types.ts";

const commands = new Map<string, AnyCommandDefinition>();

export function registerCommand<TParams = Record<string, unknown>>(
  definition: CommandDefinition<TParams> | StreamCommandDefinition
): void {
  commands.set(definition.name, definition as AnyCommandDefinition);
}

export function getRegisteredCommands(): string[] {
  return Array.from(commands.keys());
}

export function getCommand(name: string): AnyCommandDefinition | undefined {
  return commands.get(name);
}

/**
 * Dispatch a JSON command. For stream commands callers must use dispatchStream.
 * Throws UnknownCommandError or rethrows whatever the handler throws.
 */
export async function dispatch(ctx: MCPAuthContext, request: CLIRequest): Promise<CLIResponse> {
  const command = commands.get(request.command);
  if (!command) {
    throw new UnknownCommandError(request.command, getRegisteredCommands());
  }

  if (isStreamCommand(command)) {
    throw new Error(
      `Command ${request.command} is a streaming command and must be invoked via the streaming dispatch path`
    );
  }

  if (command.requiredScope !== "public") {
    requireScope(ctx, command.requiredScope);
  }

  return command.handler(ctx, request.params ?? {});
}

/**
 * Dispatch a streaming command. Returns the Response built by the handler so
 * the caller can return it directly to the HTTP runtime.
 */
export async function dispatchStream(
  ctx: MCPAuthContext,
  request: CLIRequest,
  httpRequest: Request
): Promise<Response> {
  const command = commands.get(request.command);
  if (!command) {
    throw new UnknownCommandError(request.command, getRegisteredCommands());
  }

  if (!isStreamCommand(command)) {
    throw new Error(
      `Command ${request.command} is not a streaming command; use the standard JSON dispatch path`
    );
  }

  if (command.requiredScope !== "public") {
    requireScope(ctx, command.requiredScope);
  }

  return command.handler(ctx, request.params ?? {}, httpRequest);
}

/** Thrown when command is not found - index.ts returns 400 with available_commands */
export class UnknownCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly availableCommands: string[]
  ) {
    super(`Unknown command: ${command}`);
    this.name = "UnknownCommandError";
  }
}
