"use client";

import { Button } from "@chakra-ui/react";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useState } from "react";
import { useInvalidate } from "@refinedev/core";
export default function CreateStudentReposButton() {
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
            await autograderCreateReposForStudent(supabase);
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
        {loading ? "Creating Repositories..." : "Create GitHub Repositories"}
      </Button>
    </>
  );
}
