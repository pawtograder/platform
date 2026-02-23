/**
 * Flashcards command group
 *
 * Usage:
 *   pawtograder flashcards list --class <identifier>
 *   pawtograder flashcards copy --source-class <slug> --target-class <slug> [--all] [--deck <name>]
 */

import type { Argv } from "yargs";
import { callCLI } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";

export const command = "flashcards <action>";
export const describe = "Manage flashcard decks";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List flashcard decks for a class",
      (yargs) => {
        return yargs.option("class", {
          alias: "c",
          describe: "Class ID, slug, or name",
          type: "string",
          demandOption: true
        });
      },
      async (args) => {
        try {
          const data = await callCLI("flashcards.list", {
            class: args.class as string
          });

          logger.step(`Flashcard decks for ${data.class.name}`);

          if (!data.decks || data.decks.length === 0) {
            logger.info("No flashcard decks found.");
            return;
          }

          logger.tableHeader(["ID", "Name", "Cards", "Created"]);
          for (const d of data.decks) {
            logger.tableRow([d.id, d.name, d.card_count, new Date(d.created_at).toLocaleDateString()]);
          }
          logger.blank();
          logger.info(`Total: ${data.decks.length} decks`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "copy",
      "Copy flashcard decks between classes",
      (yargs) => {
        return yargs
          .option("source-class", {
            alias: "s",
            describe: "Source class (ID, slug, or name)",
            type: "string",
            demandOption: true
          })
          .option("target-class", {
            alias: "t",
            describe: "Target class (ID, slug, or name)",
            type: "string",
            demandOption: true
          })
          .option("deck", {
            alias: "d",
            describe: "Single deck to copy (ID or name)",
            type: "string"
          })
          .option("all", {
            describe: "Copy all decks",
            type: "boolean"
          })
          .option("dry-run", {
            describe: "Show what would be copied without making changes",
            type: "boolean",
            default: false
          })
          .check((argv) => {
            const specifiedCount = [argv.deck, argv.all].filter(Boolean).length;
            if (specifiedCount !== 1) {
              throw new Error("Must specify exactly one of: --deck or --all");
            }
            return true;
          });
      },
      async (args) => {
        try {
          const data = await callCLI("flashcards.copy", {
            source_class: args.sourceClass as string,
            target_class: args.targetClass as string,
            deck: args.deck as string | undefined,
            all: args.all as boolean,
            dry_run: args.dryRun as boolean
          });

          if (data.dry_run) {
            logger.step("DRY RUN - No changes will be made");
            logger.blank();
            logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
            logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
            logger.blank();
            logger.tableHeader(["ID", "Name"]);
            for (const d of data.decks_to_copy) {
              logger.tableRow([d.id, d.name]);
            }
            return;
          }

          logger.blank();
          logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
          logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
          logger.blank();

          for (const result of data.results) {
            if (result.success) {
              logger.success(`${result.deck} → ID ${result.new_deck_id} (${result.cards_copied} cards)`);
            } else {
              logger.error(`${result.deck}: ${result.error}`);
            }
          }

          logger.blank();
          logger.step("Copy Summary");
          logger.info(`Total: ${data.summary.total}`);
          logger.info(`Succeeded: ${data.summary.succeeded}`);
          if (data.summary.failed > 0) {
            logger.warning(`Failed: ${data.summary.failed}`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
