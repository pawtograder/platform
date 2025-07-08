"use client";
import { PopConfirm } from "@/components/ui/popconfirm";
import { createClient } from "@/utils/supabase/client";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { Box, Button } from "@chakra-ui/react";
import { useInvalidate } from "@refinedev/core";

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

  const invalidate = useInvalidate();

  // makes the due date for the student and all group members NOW rather than previous.  rounds back.
  // ex if something is due at 9:15pm and the student marks "finished" at 6:30pm, their deadline will be moved
  // back 3 hours to 6:15pm so they can access the self review immediately.
  const finalizeSubmission = async () => {
    try {
      setLoading(true);
      // @ts-expect-error - Function not yet in types
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

      await invalidate({
        resource: "review_assignments",
        invalidates: ["all"]
      });
      await invalidate({
        resource: "submission_reviews",
        invalidates: ["all"]
      });
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
