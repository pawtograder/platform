/**
 * CLI-specific error class for command failures.
 */

export class CLICommandError extends Error {
  status: number;

  constructor(message: string, status: number = 400) {
    super(message);
    this.name = "CLICommandError";
    this.status = status;
  }
}
