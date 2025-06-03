"use server";

import { createClient } from "@/utils/supabase/server";
import { Database } from "@/utils/supabase/SupabaseTypes";

type StudentFlashcardProgressInsert = Database["public"]["Tables"]["student_flashcard_deck_progress"]["Insert"];
type StudentFlashcardProgressUpdate = Database["public"]["Tables"]["student_flashcard_deck_progress"]["Update"];
type FlashcardInteractionLogInsert = Database["public"]["Tables"]["flashcard_interaction_logs"]["Insert"];
type FlashcardAction = Database["public"]["Enums"]["flashcard_actions"];

/**
 * Server action to log a flashcard interaction to the database.
 *
 * @param action - The type of interaction that occurred
 * @param classId - The ID of the current class/course
 * @param deckId - The ID of the flashcard deck being practiced
 * @param studentId - The ID of the student performing the action
 * @param cardId - (Optional) The ID of the specific flashcard involved in the interaction
 * @param durationOnCardMs - (Optional) The duration in milliseconds spent on the card before this action
 * @returns Success status
 */
export async function logFlashcardInteraction(
  action: FlashcardAction,
  classId: number,
  deckId: number,
  studentId: string,
  cardId?: number | null,
  durationOnCardMs?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient();

    const logEntry: FlashcardInteractionLogInsert = {
      action,
      class_id: classId,
      deck_id: deckId,
      student_id: studentId,
      card_id: cardId,
      duration_on_card_ms: durationOnCardMs ?? 0
    };

    const { error } = await supabase.from("flashcard_interaction_logs").insert(logEntry);

    if (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to log flashcard interaction:", action, error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Server action error in logFlashcardInteraction:", error);
    return { success: false, error: "Failed to log interaction" };
  }
}

/**
 * Server action to update or create a student's progress record for a specific flashcard.
 *
 * @param classId - The ID of the current class/course
 * @param studentId - The ID of the student
 * @param cardId - The ID of the flashcard
 * @param isMastered - Whether the card is now mastered
 * @returns Success status
 */
export async function updateCardProgress(
  classId: number,
  studentId: string,
  cardId: number,
  isMastered: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const now = new Date().toISOString();

    if (isMastered) {
      // Try to get existing record first
      const { data: existingProgress } = await supabase
        .from("student_flashcard_deck_progress")
        .select("*")
        .eq("student_id", studentId)
        .eq("class_id", classId)
        .eq("card_id", cardId)
        .single();

      if (existingProgress) {
        // Update existing record
        const updateData: StudentFlashcardProgressUpdate = {
          is_mastered: true,
          last_answered_correctly_at: now,
          updated_at: now
        };

        // If this is the first time marking as mastered, set first_answered_correctly_at
        if (!existingProgress.first_answered_correctly_at) {
          updateData.first_answered_correctly_at = now;
        }

        const { error } = await supabase
          .from("student_flashcard_deck_progress")
          .update(updateData)
          .eq("student_id", studentId)
          .eq("class_id", classId)
          .eq("card_id", cardId);

        if (error) {
          // eslint-disable-next-line no-console
          console.error("Failed to update card progress:", error);
          return { success: false, error: error.message };
        }
      } else {
        // Create new record
        const insertData: StudentFlashcardProgressInsert = {
          student_id: studentId,
          class_id: classId,
          card_id: cardId,
          is_mastered: true,
          first_answered_correctly_at: now,
          last_answered_correctly_at: now,
          updated_at: now
        };

        const { error } = await supabase.from("student_flashcard_deck_progress").insert(insertData);

        if (error) {
          // eslint-disable-next-line no-console
          console.error("Failed to create card progress:", error);
          return { success: false, error: error.message };
        }
      }
    } else {
      // Mark as not mastered (returned to practice)
      const { error } = await supabase
        .from("student_flashcard_deck_progress")
        .update({
          is_mastered: false,
          updated_at: now
        })
        .eq("student_id", studentId)
        .eq("class_id", classId)
        .eq("card_id", cardId);

      if (error) {
        // eslint-disable-next-line no-console
        console.error("Failed to update card progress:", error);
        return { success: false, error: error.message };
      }
    }

    return { success: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Server action error in updateCardProgress:", error);
    return { success: false, error: "Failed to update card progress" };
  }
}

/**
 * Server action to reset all progress for a student in a specific deck.
 *
 * @param classId - The ID of the current class/course
 * @param studentId - The ID of the student
 * @param cardIds - Array of card IDs in the deck to reset
 * @returns Success status
 */
export async function resetAllProgress(
  classId: number,
  studentId: string,
  cardIds: number[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("student_flashcard_deck_progress")
      .update({
        is_mastered: false,
        updated_at: now
      })
      .eq("student_id", studentId)
      .eq("class_id", classId)
      .in("card_id", cardIds);

    if (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to reset progress:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Server action error in resetAllProgress:", error);
    return { success: false, error: "Failed to reset progress" };
  }
}
