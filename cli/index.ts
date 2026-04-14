#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Pawtograder CLI - Course Operations Platform
 *
 * A CLI tool for instructors and site admins to manage Pawtograder.
 *
 * Usage:
 *   npx tsx cli/index.ts <command> [options]
 *   npm run cli -- <command> [options]
 *
 * Examples:
 *   npm run cli -- classes list
 *   npm run cli -- assignments copy --source-class cs3500-fall-2025 --target-class cs3500-spring-2026 --all
 */

import "./load-env";
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
import { startLoginFlow, logout, getCurrentUser } from "./utils/auth";
import { getCredentialsPath } from "./utils/credentials";
import { logger, handleError } from "./utils/logger";

yargs(hideBin(process.argv))
  .scriptName("pawtograder")
  .usage("$0 <command> [options]")
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
          describe: "API URL (default: https://pawtograder.com/functions/v1/cli)",
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
  .demandCommand(1, "You must specify a command")
  .strict()
  .help()
  .alias("h", "help")
  .version("0.1.0")
  .alias("v", "version")
  .epilog("Pawtograder CLI - Course Operations Platform\nhttps://pawtograder.com")
  .wrap(100)
  .parse();
