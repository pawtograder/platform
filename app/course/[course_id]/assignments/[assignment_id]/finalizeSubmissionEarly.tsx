"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController } from "@/hooks/useAssignment";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button } from "@chakra-ui/react";
import { useMemo } from "react";

/**
 * Renders a button that allows the user to finalize their assignment submission early, updating the due date to the current time for themselves and any group members.
 *
 * Displays a confirmation dialog before executing the finalization. The button is disabled if not enabled or while loading. Upon confirmation, triggers a backend procedure to finalize the submission and updates the loading state accordingly.
 *
 * @param assignment - The assignment to be finalized early.
 * @param private_profile_id - The user's profile identifier.
 * @param enabled - Whether the finalize button is enabled.
 * @param setLoading - Callback to update the loading state.
 * @param loading - Indicates if the finalize action is in progress.
 *
 * @returns A React component rendering the finalize submission button with confirmation dialog.
 */
export default function FinalizeSubmissionEarly({
  assignment,
  private_profile_id,
  enabled,
  setLoading,
  loading
}: {
  assignment: Assignment;
  private_profile_id: string;
  enabled: boolean;
  setLoading: (loading: boolean) => void;
  loading: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const { reviewAssignments } = useAssignmentController();

  // makes the due date for the student and all group members NOW rather than previous.  rounds back.
  // ex if something is due at 9:15pm and the student marks "finished" at 6:30pm, their deadline will be moved
  // back 3 hours to 6:15pm so they can access the self review immediately.
  const finalizeSubmission = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase.rpc("finalize_submission_early", {
        this_assignment_id: assignment.id,
        this_profile_id: private_profile_id
      });

      if (error) {
        console.error("Error finalizing submission:", error);
        toaster.error({
          title: "Could not finalize submission",
          description: getStudentFacingErrorMessage(error)
        });
        return;
      }

      if (data === null || data === undefined) {
        toaster.error({
          title: "Could not finalize submission",
          description: "No response from the server. Please try again."
        });
        return;
      }

      const result = data as { success: boolean; error?: string; message?: string };

      if (!result.success) {
        const reason = result.error || result.message;
        console.error("Failed to finalize submission:", result.error);
        const friendly: Record<string, string> = {
          "Not authorized":
            "You are not allowed to finalize this submission. Make sure you are enrolled as a student in this course.",
          "Self reviews not enabled for this assignment":
            "Early finalization is only available when self-review is enabled for this assignment. Contact your instructor if you expected this option.",
          "Submission already finalized": "Your submission is already finalized for this assignment.",
          "Assignment not found": "This assignment could not be found. Refresh the page or contact your instructor.",
          "No active submission found":
            "You don't have an active submission to finalize. Create or resume your submission first.",
          "Self review already assigned": "A self-review has already been assigned for this submission."
        };
        const mapped = reason && friendly[reason];
        toaster.error({
          title: "Could not finalize submission",
          description:
            mapped || (reason ? getStudentFacingErrorMessage(reason) : "This action is not allowed right now.")
        });
        return;
      }
      // The submission *is* finalized at this point — the RPC committed the
      // state change. Anything that fails after this is post-success cache
      // refresh; it must not surface as a "Could not finalize submission"
      // error or the user will think the action failed and retry.
      toaster.success({
        title: "Submission finalized",
        description: "Your submission time is set. You can continue with self-review if your course uses it."
      });

      // Refresh the review_assignments controller so the self-review row
      // created by finalize_submission_early is in cache before the UI
      // renders the "Complete Self Review" button. Failures here are
      // non-fatal (the row will arrive via realtime or the next page load).
      try {
        await reviewAssignments.refetchAll();
      } catch (refetchErr) {
        console.warn("Submission finalized, but reviewAssignments refetch failed:", refetchErr);
        toaster.create({
          type: "warning",
          title: "Self-review may take a moment to appear",
          description: "Your submission was finalized. If the self-review button doesn't show up, refresh the page."
        });
      }
    } catch (err) {
      console.error("Unexpected error finalizing submission:", err);
      toaster.error({
        title: "Could not finalize submission",
        description: getStudentFacingErrorMessage(err)
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box width="50%" alignItems={"center"}>
      <PopConfirm
        triggerLabel="Finalize Submission Early"
        trigger={
          <Button variant="surface" colorPalette="green" loading={loading} disabled={!enabled}>
            Finalize Submission Early
          </Button>
        }
        confirmHeader="Finalize Submission Early"
        confirmText="Are you sure you want to finalize your submission early? You will not be able to change your submission after this."
        onConfirm={finalizeSubmission}
      />
    </Box>
  );
}
