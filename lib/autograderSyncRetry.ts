import { toaster } from "@/components/ui/toaster";
import { assignmentSyncAutograderWorkflow } from "@/lib/edgeFunctions";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";

type SyncTarget = { assignmentId: number; classId: number; supabase: SupabaseClient<Database> };

/**
 * Runs the handout workflow sync again for the flag already saved on the assignment. The sync is
 * idempotent: it commits nothing when the handout already matches, and it rewrites a hash or
 * revision that an earlier attempt failed to record.
 */
export async function retryAutograderSync(target: SyncTarget): Promise<void> {
  try {
    const result = await assignmentSyncAutograderWorkflow(
      { assignment_id: target.assignmentId, class_id: target.classId },
      target.supabase
    );
    if (result?.forgejo_workflow_record_failed) {
      toastAutograderNotRecorded(result.forgejo_workflow_record_failed, target);
      return;
    }
    toaster.create({
      title: "Autograder workflow synced",
      description: `The handout's grade.yml matches the saved setting (autograder ${result?.has_autograder ? "on" : "off"}).`,
      type: "success"
    });
  } catch (error) {
    toastAutograderSyncFailed(error instanceof Error ? error.message : String(error), target);
  }
}

const retryAction = (target: SyncTarget) => ({
  label: "Retry sync",
  onClick: () => {
    void retryAutograderSync(target);
  }
});

/** The handout holds the requested state, but its hash or revision was not written. */
export function toastAutograderNotRecorded(detail: string, target: SyncTarget): void {
  toaster.create({
    title: "Autograder setting saved, but not fully recorded",
    description:
      `The handout's grade.yml was updated, but its workflow hash or revision could not be saved (${detail}). ` +
      "Submissions may be rejected for a workflow mismatch until the sync is retried.",
    type: "warning",
    duration: Infinity,
    action: retryAction(target)
  });
}

/** The saved flag and the handout disagree, and only a sync brings them back together. */
export function toastAutograderSyncFailed(detail: string, target: SyncTarget): void {
  toaster.create({
    title: "Autograder workflow not synced",
    description:
      `The autograder setting is saved, but the handout's grade.yml could not be updated (${detail}). ` +
      "Retry the sync to bring the handout in line with the setting.",
    type: "error",
    duration: Infinity,
    action: retryAction(target)
  });
}
