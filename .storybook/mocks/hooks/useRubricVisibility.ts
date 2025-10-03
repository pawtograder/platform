import type { HydratedRubricCheck } from "@/utils/supabase/DatabaseTypes";

export function useShouldShowRubricCheck({
  check
}: {
  check: HydratedRubricCheck;
  rubricCheckComments?: unknown[];
  reviewForThisRubric?: unknown;
  isGrader?: boolean;
  isPreviewMode?: boolean;
}) {
  return true;
}
