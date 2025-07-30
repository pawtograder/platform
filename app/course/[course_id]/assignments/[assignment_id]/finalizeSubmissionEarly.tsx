"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button } from "@chakra-ui/react";

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
  const supabase = createClient();

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
        // You might want to show a toast notification here
        return;
      }

      const result = data as { success: boolean; error?: string; message?: string };

      if (result && !result.success) {
        console.error("Failed to finalize submission:", result.error);
        // You might want to show a toast notification here
        return;
      }
    } catch (err) {
      console.error("Unexpected error finalizing submission:", err);
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
        onCancel={() => {}}
      />
    </Box>
  );
}
