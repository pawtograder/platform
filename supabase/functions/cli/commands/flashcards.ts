/**
 * Flashcards commands - list, copy.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import { CLICommandError } from "../errors.ts";
import type { CLIResponse, FlashcardsListParams, FlashcardsCopyParams } from "../types.ts";

async function handleFlashcardsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier } = params as unknown as FlashcardsListParams;
  if (!classIdentifier) throw new CLICommandError("class is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  const { data: decks, error } = await supabase
    .from("flashcard_decks")
    .select("id, name, description, created_at")
    .eq("class_id", classData.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) throw new CLICommandError(`Failed to fetch flashcard decks: ${error.message}`);

  // Paged: this reads every card in the class purely to tally per-deck counts, so
  // a class with more than max_rows cards reported zero or an undercount for the
  // decks that fell past the cap.
  const cardCounts = await pageAll<{ deck_id: number }>(
    () =>
      supabase
        .from("flashcards")
        .select("deck_id")
        .eq("class_id", classData.id)
        .is("deleted_at", null)
        .order("id", { ascending: true }),
    "Error fetching flashcard counts"
  );

  const countMap = new Map<number, number>();
  if (cardCounts) {
    for (const card of cardCounts) {
      countMap.set(card.deck_id, (countMap.get(card.deck_id) ?? 0) + 1);
    }
  }

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      decks: (decks ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        card_count: countMap.get(d.id) ?? 0,
        created_at: d.created_at
      }))
    }
  };
}

async function handleFlashcardsCopy(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as FlashcardsCopyParams;
  const sourceClassId = p.source_class;
  const targetClassId = p.target_class;
  const deckIdentifier = p.deck;
  const copyAll = p.all === true;
  const dryRun = p.dry_run === true;

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");
  if (!deckIdentifier && !copyAll) throw new CLICommandError("Must specify deck or all");

  const supabase = getAdminClient();
  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);
  // Both sides: reading the source and writing the target each need access, or a
  // grader in one class could copy content into a class they do not belong to.
  await assertUserCanAccessClass(supabase, ctx.userId, sourceClass.id);
  await assertUserCanAccessClass(supabase, ctx.userId, targetClass.id);

  if (sourceClass.id === targetClass.id) {
    throw new CLICommandError("Source and target classes must be different");
  }

  let decksQuery = supabase.from("flashcard_decks").select("*").eq("class_id", sourceClass.id).is("deleted_at", null);

  if (deckIdentifier) {
    // Strictly all-digits, not parseInt: parseInt("3 Recursion") is 3, so a deck
    // whose name begins with a number was silently swapped for whichever deck
    // holds that id — and copied, with all its cards, into the target class.
    if (/^\d+$/.test(deckIdentifier.trim())) {
      decksQuery = decksQuery.eq("id", Number(deckIdentifier.trim()));
    } else {
      decksQuery = decksQuery.eq("name", deckIdentifier);
    }
  }

  const { data: sourceDecks, error: decksError } = await decksQuery;
  if (decksError) throw new CLICommandError(`Failed to fetch source decks: ${decksError.message}`, 500);
  if (deckIdentifier && (sourceDecks?.length ?? 0) > 1) {
    throw new CLICommandError(
      `Ambiguous deck "${deckIdentifier}": ${(sourceDecks ?? []).map((d) => d.id).join(", ")}. Pass a deck id.`,
      400
    );
  }
  if (!sourceDecks || sourceDecks.length === 0) {
    throw new CLICommandError("No flashcard decks found to copy");
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        decks_to_copy: sourceDecks.map((d) => ({ id: d.id, name: d.name, description: d.description }))
      }
    };
  }

  const resolvedCreatorId = ctx.userId || sourceDecks[0].creator_id;
  const results: Array<{
    deck: string;
    success: boolean;
    new_deck_id?: number;
    cards_copied?: number;
    error?: string;
  }> = [];

  for (const sourceDeck of sourceDecks) {
    try {
      const { data: newDeck, error: createError } = await supabase
        .from("flashcard_decks")
        .insert({
          class_id: targetClass.id,
          creator_id: resolvedCreatorId,
          name: sourceDeck.name,
          description: sourceDeck.description
        })
        .select("id")
        .single();

      if (createError || !newDeck) {
        results.push({ deck: sourceDeck.name, success: false, error: createError?.message ?? "Unknown" });
        continue;
      }

      // Paged, and the error is no longer discarded: unpaged, a deck of more than
      // max_rows cards copied only the first 1000 and still reported success,
      // and a failed read created the target deck empty with cards_copied: 0.
      const sourceCards = await pageAll<{
        title: string;
        prompt: string;
        answer: string;
        order: number | null;
      }>(
        () =>
          supabase
            .from("flashcards")
            .select("*")
            .eq("deck_id", sourceDeck.id)
            .is("deleted_at", null)
            .order("order", { ascending: true, nullsFirst: false })
            .order("id", { ascending: true }),
        `Failed to read cards for deck ${sourceDeck.id}`
      );

      let cardCount = 0;
      if (sourceCards.length > 0) {
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
          results.push({ deck: sourceDeck.name, success: false, error: `Cards failed: ${insertError.message}` });
          continue;
        }
        cardCount = sourceCards.length;
      }

      results.push({ deck: sourceDeck.name, success: true, new_deck_id: newDeck.id, cards_copied: cardCount });
    } catch (err) {
      results.push({ deck: sourceDeck.name, success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    success: true,
    data: {
      source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
      target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
      results,
      summary: {
        total: sourceDecks.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length
      }
    }
  };
}

registerCommand({
  name: "flashcards.list",
  requiredScope: "cli:read",
  handler: handleFlashcardsList
});

registerCommand({
  name: "flashcards.copy",
  requiredScope: "cli:write",
  handler: handleFlashcardsCopy
});
