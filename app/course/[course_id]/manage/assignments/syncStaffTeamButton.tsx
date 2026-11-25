"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { autograderSyncStaffTeam } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
export default function SyncStaffTeamButton({ course_id }: { course_id: number }) {
  return (
    <Button
      size="xs"
      variant="surface"
      colorPalette="green"
      onClick={() => {
        const supabase = createClient();
        autograderSyncStaffTeam({ course_id: Number(course_id) }, supabase)
          .then(() => {
            toaster.create({
              title: "Staff team synced"
            });
          })
          .catch((error) => {
            toaster.error({
              title: "Failed to sync staff team",
              description: error instanceof Error ? error.message : "An unknown error occurred"
            });
          });
      }}
    >
      Sync Staff Team
    </Button>
  );
}
