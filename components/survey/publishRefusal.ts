import { toaster } from "@/components/ui/toaster";

/**
 * If `error` is the database refusing to publish a survey whose questions share a name, show its
 * message and return true (#1005). The trigger `surveys_reject_duplicate_question_names` is the
 * only place that decides what counts as a repeat, and its message names the repeated question
 * and says how to fix it. PostgREST errors are plain objects, not `Error`s, so this takes `unknown`.
 */
export function reportDuplicateNamesRefusal(error: unknown): boolean {
  const refusal = error as { code?: string; details?: string | null; message?: string } | null;
  if (refusal?.code !== "23514" || !refusal.details?.includes("surveys_reject_duplicate_question_names")) {
    return false;
  }
  // Long enough to read three sentences and find the question; the close button is for when it isn't needed.
  toaster.error({
    title: "Cannot Publish Survey",
    description: refusal.message,
    meta: { closable: true },
    duration: 30_000
  });
  return true;
}
