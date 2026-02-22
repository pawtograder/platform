/**
 * Flashcards command group
 *
 * Usage:
 *   pawtograder flashcards list --class <identifier>
 *   pawtograder flashcards copy --source-class <slug> --target-class <slug> [--all] [--deck <name>]
 */

import type { Argv } from "yargs";
import { resolveClass, getSupabaseClient } from "../../utils/db";
import { logger, handleError, CLIError } from "../../utils/logger";

export const command = "flashcards <action>";
export const describe = "Manage flashcard decks";

interface FlashcardDeck {
  id: number;
  name: string;
  description: string | null;
  class_id: number;
  creator_id: string;
  created_at: string;
}

interface Flashcard {
  id: number;
  deck_id: number;
  class_id: number;
  title: string;
  prompt: string;
  answer: string;
  order: number | null;
}

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
          const classData = await resolveClass(args.class as string);
          logger.step(`Flashcard decks for ${classData.name}`);

          const supabase = getSupabaseClient();
          const { data: decks, error } = await supabase
            .from("flashcard_decks")
            .select("id, name, description, created_at")
            .eq("class_id", classData.id)
            .is("deleted_at", null)
            .order("created_at", { ascending: true });

          if (error) {
            throw new CLIError(`Failed to fetch flashcard decks: ${error.message}`);
          }

          if (!decks || decks.length === 0) {
            logger.info("No flashcard decks found.");
            return;
          }

          // Get card counts for each deck
          const { data: cardCounts, error: countError } = await supabase
            .from("flashcards")
            .select("deck_id")
            .eq("class_id", classData.id)
            .is("deleted_at", null);

          const countMap = new Map<number, number>();
          if (cardCounts) {
            for (const card of cardCounts) {
              countMap.set(card.deck_id, (countMap.get(card.deck_id) || 0) + 1);
            }
          }

          logger.tableHeader(["ID", "Name", "Cards", "Created"]);
          for (const deck of decks) {
            const cardCount = countMap.get(deck.id) || 0;
            const created = new Date(deck.created_at).toLocaleDateString();
            logger.tableRow([deck.id, deck.name, cardCount.toString(), created]);
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
          // 1. Resolve classes
          logger.step("Resolving classes...");
          const sourceClass = await resolveClass(args.sourceClass as string);
          const targetClass = await resolveClass(args.targetClass as string);

          logger.info(`Source: ${sourceClass.name} (${sourceClass.slug})`);
          logger.info(`Target: ${targetClass.name} (${targetClass.slug})`);

          if (sourceClass.id === targetClass.id) {
            throw new CLIError("Source and target classes must be different");
          }

          const supabase = getSupabaseClient();

          // 2. Fetch decks to copy
          let decksQuery = supabase
            .from("flashcard_decks")
            .select("*")
            .eq("class_id", sourceClass.id)
            .is("deleted_at", null);

          if (args.deck) {
            // Try to parse as ID first
            const deckId = parseInt(args.deck as string, 10);
            if (!isNaN(deckId)) {
              decksQuery = decksQuery.eq("id", deckId);
            } else {
              decksQuery = decksQuery.eq("name", args.deck);
            }
          }

          const { data: sourceDecks, error: decksError } = await decksQuery;

          if (decksError) {
            throw new CLIError(`Failed to fetch source decks: ${decksError.message}`);
          }

          if (!sourceDecks || sourceDecks.length === 0) {
            logger.warning("No flashcard decks found to copy.");
            return;
          }

          logger.info(`Found ${sourceDecks.length} deck(s) to copy`);

          // 3. Dry run - show what would be copied
          if (args.dryRun) {
            logger.step("DRY RUN - No changes will be made");
            logger.blank();
            logger.tableHeader(["Deck Name", "Description"]);
            for (const deck of sourceDecks) {
              logger.tableRow([deck.name, deck.description || "(none)"]);
            }
            return;
          }

          // 4. Get the creator_id (current user from service role, use first deck's creator as fallback)
          // Since we're using service role, we'll use the source deck's creator_id
          const creatorId = sourceDecks[0].creator_id;

          // 5. Copy each deck
          let successCount = 0;
          for (const sourceDeck of sourceDecks) {
            logger.step(`Copying deck: ${sourceDeck.name}`);

            try {
              // Create new deck
              const { data: newDeck, error: createError } = await supabase
                .from("flashcard_decks")
                .insert({
                  class_id: targetClass.id,
                  creator_id: creatorId,
                  name: sourceDeck.name,
                  description: sourceDeck.description
                })
                .select("id")
                .single();

              if (createError || !newDeck) {
                throw new CLIError(`Failed to create deck: ${createError?.message || "Unknown error"}`);
              }

              // Fetch source cards
              const { data: sourceCards, error: cardsError } = await supabase
                .from("flashcards")
                .select("*")
                .eq("deck_id", sourceDeck.id)
                .is("deleted_at", null)
                .order("order", { ascending: true, nullsFirst: false });

              if (cardsError) {
                throw new CLIError(`Failed to fetch cards: ${cardsError.message}`);
              }

              // Copy cards
              if (sourceCards && sourceCards.length > 0) {
                const newCards = sourceCards.map((card) => ({
                  deck_id: newDeck.id,
                  class_id: targetClass.id,
                  title: card.title,
                  prompt: card.prompt,
                  answer: card.answer,
                  order: card.order
                }));

                const { error: insertError } = await supabase.from("flashcards").insert(newCards);

                if (insertError) {
                  throw new CLIError(`Failed to copy cards: ${insertError.message}`);
                }

                logger.success(`  Copied ${sourceCards.length} card(s)`);
              } else {
                logger.info("  No cards to copy");
              }

              successCount++;
              logger.success(`  Deck created with ID ${newDeck.id}`);
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.error(`  Failed: ${errorMsg}`);
            }
          }

          // 6. Summary
          logger.blank();
          logger.step("Copy Summary");
          logger.info(`Successfully copied: ${successCount}/${sourceDecks.length} deck(s)`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
