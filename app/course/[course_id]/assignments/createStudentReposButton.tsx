"use client";

import { Button } from "@chakra-ui/react";
import { autograderCreateReposForStudent, autograderSyncAllPermissionsForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { useState } from "react";
import { useInvalidate } from "@refinedev/core";
export default function CreateStudentReposButton({
  syncAllPermissions,
  classId,
  assignmentId,
  forTestAssignment
}: {
  syncAllPermissions?: boolean;
  /**
   * Confines the work to one course. Without it the edge function walks every class the caller
   * belongs to, doing org-membership and permission work across all of them.
   */
  classId?: number;
  assignmentId?: number;
  /** When true with assignmentId, allows instructor Test Assignment repo for groups-only assignments. */
  forTestAssignment?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const invalidate = useInvalidate();
  // The Test Assignment button makes one repository, for this assignment and this staff member.
  // Labelling it "Create GitHub Repositories" read as though it provisioned the whole course.
  const label = forTestAssignment ? "Create my test repo" : "Create GitHub Repositories";
  const busyLabel = forTestAssignment ? "Creating your test repo..." : "Creating Repositories...";
  return (
    <>
      <Button
        onClick={async () => {
          try {
            setLoading(true);
            const supabase = createClient();
            if (syncAllPermissions) {
              await autograderSyncAllPermissionsForStudent(supabase);
            } else {
              await autograderCreateReposForStudent(supabase, assignmentId, {
                ...(forTestAssignment ? { forTestAssignment: true } : {}),
                ...(classId !== undefined ? { classId } : {})
              });
            }
            toaster.success(
              forTestAssignment
                ? {
                    title: "Test repository created",
                    description: "Your test repository for this assignment is ready. Refresh to see it."
                  }
                : {
                    title: "Repositories created",
                    description: "Repositories created successfully. Please refresh the page to see them."
                  }
            );
            invalidate({
              resource: "repositories",
              invalidates: ["all"]
            });
          } catch (error) {
            toaster.error({
              title: forTestAssignment ? "Error creating your test repository" : "Error creating repositories",
              description: error instanceof Error ? error.message : "An unknown error occurred"
            });
          } finally {
            setLoading(false);
          }
        }}
        loading={loading}
      >
        {loading ? busyLabel : syncAllPermissions ? "Re-Sync All Permissions" : label}
      </Button>
    </>
  );
}
