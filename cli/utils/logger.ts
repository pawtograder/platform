/* eslint-disable no-console */
/**
 * Logger utilities for the Pawtograder CLI
 *
 * Provides consistent logging with emoji prefixes following existing script patterns.
 */

export const logger = {
  /** Info message (no prefix) */
  info: (msg: string) => console.log(`   ${msg}`),

  /** Success message (checkmark) */
  success: (msg: string) => console.log(`✓ ${msg}`),

  /** Warning message */
  warning: (msg: string) => console.log(`⚠️  ${msg}`),

  /** Error message (cross) */
  error: (msg: string) => console.error(`✗ ${msg}`),

  /** Step/section header */
  step: (msg: string) => console.log(`\n📋 ${msg}`),

  /** Progress indicator */
  progress: (current: number, total: number, msg: string) => console.log(`   [${current}/${total}] ${msg}`),

  /** Blank line */
  blank: () => console.log(),

  /** Raw output (no formatting) */
  raw: (msg: string) => console.log(msg),

  /** Table header */
  tableHeader: (columns: string[]) => {
    console.log(`\n   ${columns.join("\t")}`);
    console.log(`   ${columns.map((c) => "-".repeat(c.length)).join("\t")}`);
  },

  /** Table row */
  tableRow: (values: (string | number | null | undefined)[]) => {
    console.log(`   ${values.map((v) => v ?? "-").join("\t")}`);
  }
};

/**
 * Custom error class for CLI operations
 */
export class CLIError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = "CLIError";
  }
}

/**
 * Handle errors consistently, exiting with appropriate code
 */
export function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    logger.error(error.message);
    process.exit(error.exitCode);
  }

  // Unexpected error
  if (error instanceof Error) {
    logger.error(`Unexpected error: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
  } else {
    logger.error(`Unexpected error: ${String(error)}`);
  }

  process.exit(1);
}
