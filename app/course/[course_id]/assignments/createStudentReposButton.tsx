"use client";

import { Button } from "@chakra-ui/react";
import { autograderCreateReposForStudent } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { toaster, Toaster } from "@/components/ui/toaster";
export default function CreateStudentReposButton() {
  const supabase = createClient();
  return (
    <>
      <Toaster />
      <Button
        onClick={async () => {
          try {
            await autograderCreateReposForStudent(supabase);
            toaster.success({
              title: "Repositories created",
              description: "Repositories created successfully. Please refresh the page to see them."
            });
          } catch (error) {
            toaster.error({
              title: "Error creating repositories",
              description: error instanceof Error ? error.message : "An unknown error occurred"
            });
          }
        }}
      >
        Create GitHub Repositories
      </Button>
    </>
  );
}
