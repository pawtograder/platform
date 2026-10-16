"use client";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { EdgeFunctionError, forgejoProvision } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { useState } from "react";
import { LuGitBranch } from "react-icons/lu";

export function CreateForgejoRepos({ courseId, assignmentId }: { courseId: number; assignmentId: number }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      loading={loading}
      loadingText="Creating Forgejo repos..."
      variant="outline"
      size="sm"
      onClick={async () => {
        setLoading(true);
        try {
          const result = await forgejoProvision({ class_id: courseId, assignment_id: assignmentId }, createClient());
          const ready = result.repos.filter((r) => r.ready).length;
          toaster.success({
            title: "Forgejo repositories ready",
            description: `${ready} of ${result.repos.length} student repositories are ready. ${result.accounts_created} new Forgejo accounts were created.`
          });
        } catch (e) {
          toaster.error({
            title: "Error creating Forgejo repositories",
            description: e instanceof EdgeFunctionError ? e.details : e instanceof Error ? e.message : String(e)
          });
        } finally {
          setLoading(false);
        }
      }}
    >
      <LuGitBranch />
      Create Forgejo repos
    </Button>
  );
}
