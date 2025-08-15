"use client";

import { Button } from "@chakra-ui/react";
import { autograderCreateReposForStudent, autograderSyncAllPermissionsForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useState } from "react";
import { useInvalidate } from "@refinedev/core";
export default function CreateStudentReposButton({
  syncAllPermissions,
  assignmentId
}: {
  syncAllPermissions?: boolean;
  assignmentId?: number;
}) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const invalidate = useInvalidate();
  return (
    <>
      <Toaster />
      <Button
        onClick={async () => {
          try {
            setLoading(true);
            if (syncAllPermissions) {
              await autograderSyncAllPermissionsForStudent(supabase);
            } else {
              await autograderCreateReposForStudent(supabase, assignmentId);
            }
            toaster.success({
              title: "Repositories created",
              description: "Repositories created successfully. Please refresh the page to see them."
            });
            invalidate({
              resource: "repositories",
              invalidates: ["all"]
            });
          } catch (error) {
            toaster.error({
              title: "Error creating repositories",
              description: error instanceof Error ? error.message : "An unknown error occurred"
            });
          } finally {
            setLoading(false);
          }
        }}
        loading={loading}
      >
        {loading
          ? "Creating Repositories..."
          : syncAllPermissions
            ? "Re-Sync All Permissions"
            : "Create GitHub Repositories"}
      </Button>
    </>
  );
}
