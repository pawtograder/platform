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
import * as classesCommand from "./commands/classes";
import * as assignmentsCommand from "./commands/assignments";
import * as flashcardsCommand from "./commands/flashcards";
import * as rubricsCommand from "./commands/rubrics";
import * as submissionsCommand from "./commands/submissions";
import * as helpRequestsCommand from "./commands/help-requests";
import * as discussionsCommand from "./commands/discussions";
import * as reviewsCommand from "./commands/reviews";

yargs(hideBin(process.argv))
  .scriptName("pawtograder")
  .usage("$0 <command> [options]")
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
