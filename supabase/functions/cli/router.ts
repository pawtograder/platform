/**
 * Command registration and dispatch for CLI.
 */

import type { CommandDefinition } from "./commands/base.ts";
import { requireScope } from "../_shared/MCPAuth.ts";
import type { MCPAuthContext } from "../_shared/MCPAuth.ts";
import type { CLIRequest, CLIResponse } from "./types.ts";

const commands = new Map<string, CommandDefinition>();

export function registerCommand<TParams = Record<string, unknown>>(definition: CommandDefinition<TParams>): void {
  commands.set(definition.name, definition as CommandDefinition);
}

export function getRegisteredCommands(): string[] {
  return Array.from(commands.keys());
}

export async function dispatch(ctx: MCPAuthContext, request: CLIRequest): Promise<CLIResponse> {
  const command = commands.get(request.command);
  if (!command) {
    throw new UnknownCommandError(request.command, getRegisteredCommands());
  }

  if (command.requiredScope) {
    requireScope(ctx, command.requiredScope);
  }

  return command.handler(ctx, request.params ?? {});
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
