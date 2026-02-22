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

import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Load environment variables before anything else
dotenv.config({ path: ".env.local" });

// Import command modules
import * as authCommand from "./commands/auth";
import * as classesCommand from "./commands/classes";
import * as assignmentsCommand from "./commands/assignments";
import * as flashcardsCommand from "./commands/flashcards";
import * as rubricsCommand from "./commands/rubrics";
import * as submissionsCommand from "./commands/submissions";
import * as helpRequestsCommand from "./commands/help-requests";
import * as discussionsCommand from "./commands/discussions";
import * as reviewsCommand from "./commands/reviews";
import { startLoginFlow, logout, getCurrentUser } from "./utils/auth";
import { getCredentialsPath } from "./utils/credentials";
import { logger, handleError } from "./utils/logger";

yargs(hideBin(process.argv))
  .scriptName("pawtograder")
  .usage("$0 <command> [options]")
  // Auth commands
  .command(authCommand)
  .command(
    "login",
    "Sign in to Pawtograder via browser",
    (yargs) => {
      return yargs
        .option("email", {
          alias: "e",
          describe: "Email address for magic link",
          type: "string"
        })
        .option("no-browser", {
          describe: "Don't auto-open browser, show URL instead",
          type: "boolean",
          default: false
        });
    },
    async (args) => {
      try {
        await startLoginFlow({
          email: args.email as string | undefined,
          noBrowser: args["no-browser"] as boolean
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
  .command(flashcardsCommand)
  .command(rubricsCommand)
  .command(submissionsCommand)
  .command(helpRequestsCommand)
  .command(discussionsCommand)
  .command(reviewsCommand)
  .demandCommand(1, "You must specify a command")
  .strict()
  .help()
  .alias("h", "help")
  .version("0.1.0")
  .alias("v", "version")
  .epilog("Pawtograder CLI - Course Operations Platform\nhttps://pawtograder.com")
  .wrap(100)
  .parse();
