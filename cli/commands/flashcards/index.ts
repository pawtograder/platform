/**
 * Flashcards command group
 *
 * Usage:
 *   pawtograder flashcards list --class <identifier>
 *   pawtograder flashcards copy --source-class <slug> --target-class <slug> [--all] [--deck <name>]
 */

import type { Argv } from "yargs";
import { apiCall } from "../../utils/api";
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
          const data = await apiCall("flashcards.list", { class: args.class as string });

          logger.step(`Flashcard decks for ${data.class.name}`);

          const decks = data.decks;

          if (!decks || decks.length === 0) {
            logger.info("No flashcard decks found.");
            return;
          }

          logger.tableHeader(["ID", "Name", "Cards", "Created"]);
          for (const deck of decks) {
            const created = new Date(deck.created_at).toLocaleDateString();
            logger.tableRow([deck.id, deck.name, deck.card_count.toString(), created]);
          }
          logger.blank();
          logger.info(`Total: ${decks.length} deck(s)`);
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
            describe: "Copy all flashcard decks from source class",
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
          logger.step("Copying flashcard decks...");

          const params: Record<string, unknown> = {
            source_class: args.sourceClass,
            target_class: args.targetClass,
            dry_run: args.dryRun
          };

          if (args.deck) {
            params.deck = args.deck;
          } else if (args.all) {
            params.all = true;
          }

          const data = await apiCall("flashcards.copy", params);

          if (data.dry_run) {
            logger.step("DRY RUN - No changes will be made");
            logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
            logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
            logger.blank();

            logger.tableHeader(["Deck Name", "Description"]);
            for (const deck of data.decks_to_copy) {
              logger.tableRow([deck.name, deck.description || "(none)"]);
            }
            return;
          }

          // Show results
          logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
          logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
          logger.blank();

          for (const r of data.results) {
            if (r.success) {
              logger.success(`Copied: ${r.deck} -> ID ${r.new_deck_id} (${r.cards_copied} cards)`);
            } else {
              logger.error(`Failed: ${r.deck} - ${r.error}`);
            }
          }

          // Summary
          logger.blank();
          logger.step("Copy Summary");
          logger.info(`Successfully copied: ${data.summary.succeeded}/${data.summary.total} deck(s)`);
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
