/* eslint-disable no-console */
/**
 * Logger utilities for the Pawtograder CLI
 *
 * Provides consistent logging with emoji prefixes following existing script patterns.
 */

/**
 * Whether human-readable progress output is suppressed.
 *
 * Set from a yargs middleware whenever `--json` is passed. Every method below except
 * `error` writes to stdout, and some commands log progress *before* the request whose
 * response `emitJson` prints — so under `--json` a consumer piping stdout to a parser
 * received progress text ahead of the JSON. Silencing at the logger fixes that for every
 * command at once, rather than each one remembering to check the flag.
 *
 * `error` is exempt: it goes to stderr, which is not the parsed stream.
 */
let quiet = false;

/** Called by the CLI's middleware when `--json` is in effect. */
export function setLoggerQuiet(value: boolean): void {
  quiet = value;
}

/** stdout, unless `--json` asked for a machine-readable stream. */
function out(msg: string): void {
  if (quiet) return;
  console.log(msg);
}

export const logger = {
  /** Info message (no prefix) */
  info: (msg: string) => out(`   ${msg}`),

  /** Success message (checkmark) */
  success: (msg: string) => out(`✓ ${msg}`),

  /** Warning message */
  warning: (msg: string) => out(`⚠️  ${msg}`),

  /** Error message (cross). Goes to stderr, so it is never suppressed. */
  error: (msg: string) => console.error(`✗ ${msg}`),

  /** Step/section header */
  step: (msg: string) => out(`\n📋 ${msg}`),

  /** Progress indicator */
  progress: (current: number, total: number, msg: string) => out(`   [${current}/${total}] ${msg}`),

  /** Blank line */
  blank: () => out(""),

  /** Raw output (no formatting) */
  raw: (msg: string) => out(msg)

  // Tables live in ./output.ts (`printTable`), which pads columns to their
  // widest cell. The tab-joined helpers that used to be here only lined up when
  // every cell was shorter than a tab stop.
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
