/**
 * Pawtograder CLI - Course Operations Platform
 *
 * The yargs program itself. Two entry points wrap it:
 *   - `index.ts`, used in-repo by `npm run cli`, which also loads .env files
 *   - `bin.ts`, the published binary, which does not
 *
 * Keeping the program here means neither entry point duplicates the command
 * wiring.
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Import command modules
import * as classesCommand from "./commands/classes";
import * as assignmentsCommand from "./commands/assignments";
import * as surveysCommand from "./commands/surveys";
import * as flashcardsCommand from "./commands/flashcards";
import * as rubricsCommand from "./commands/rubrics";
import * as submissionsCommand from "./commands/submissions";
import * as helpRequestsCommand from "./commands/help-requests";
import * as discussionsCommand from "./commands/discussions";
import * as reviewsCommand from "./commands/reviews";
import * as reposCommand from "./commands/repos";
import * as assessmentCommand from "./commands/assessment";
import { DEFAULT_API_URL } from "./utils/api";
import { startLoginFlow, logout, getCurrentUser } from "./utils/auth";
import { getCredentialsPath } from "./utils/credentials";
import { logger, handleError, setLoggerQuiet } from "./utils/logger";

/**
 * Replaced at build time with the published package's version
 * (`esbuild --define:__CLI_VERSION__`). Undefined when running from source via
 * tsx, so `npm run cli -- --version` reports a dev marker rather than a stale
 * hardcoded number.
 */
declare const __CLI_VERSION__: string | undefined;

function resolveVersion(): string {
  return typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";
}

/** Parses argv and dispatches. Both entry points call this. */
export function run(argv: string[] = hideBin(process.argv)): void {
  yargs(argv)
    .scriptName("pawtograder")
    .usage("$0 <command> [options]")
    // Silences progress logging under --json for every command, including the ones
    // that log before the request whose response is printed. Without it a consumer
    // piping stdout to a parser got progress text ahead of the JSON.
    .middleware((args) => {
      if (args.json === true) setLoggerQuiet(true);
    })
    .command(
      "login",
      "Authenticate with a Pawtograder API token",
      (yargs) => {
        return yargs
          .option("token", {
            alias: "t",
            describe: "API token (will prompt if not provided)",
            type: "string"
          })
          .option("url", {
            // Interpolated rather than hardcoded (see #882): a literal here
            // drifted from the real default once before. Self-hosted users need
            // their own https://api.<zone>, which the app shows in
            // Settings → API Tokens.
            describe: `API gateway origin or full endpoint, e.g. https://api.example.edu (default: ${DEFAULT_API_URL})`,
            type: "string"
          });
      },
      async (args) => {
        try {
          await startLoginFlow({
            token: args.token as string | undefined,
            url: args.url as string | undefined
          });
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "logout",
      "Sign out and clear stored credentials",
      () => {},
      async () => {
        try {
          await logout();
          logger.success("Logged out successfully");
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "whoami",
      "Show current authenticated user",
      () => {},
      async () => {
        try {
          const user = await getCurrentUser();
          if (user) {
            logger.step("Current User");
            logger.info(`Email: ${user.email}`);
            logger.info(`Name: ${user.name || "(not set)"}`);
            logger.info(`User ID: ${user.id}`);
            logger.blank();
            logger.info(`Credentials: ${getCredentialsPath()}`);
          } else {
            logger.info("Not logged in. Run 'pawtograder login' to authenticate.");
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    // Resource commands
    .command(classesCommand)
    .command(assignmentsCommand)
    .command(surveysCommand)
    .command(flashcardsCommand)
    .command(rubricsCommand)
    .command(submissionsCommand)
    .command(helpRequestsCommand)
    .command(discussionsCommand)
    .command(reviewsCommand)
    .command(reposCommand)
    .command(assessmentCommand)
    .demandCommand(1, "You must specify a command")
    .strict()
    .help()
    .alias("h", "help")
    .version(resolveVersion())
    .alias("v", "version")
    .epilog("Pawtograder CLI - Course Operations Platform\nhttps://pawtograder.com")
    .wrap(100)
    .parse();
}
