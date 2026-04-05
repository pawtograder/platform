import { AppNestedRouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { Box } from "@chakra-ui/react";
import { Suspense } from "react";
import { ManageAssignmentsTable } from "./ManageAssignmentsTable";
import { ManageAssignmentsToolbar } from "./ManageAssignmentsToolbar";

/**
 * Manage assignments: toolbar streams immediately; table suspends on cached overview fetch.
 */
export default async function ManageAssignmentsPage({ params }: { params: Promise<{ course_id: string }> }) {
  const { course_id } = await params;
  const courseId = Number(course_id);

  return (
    <Box>
      <ManageAssignmentsToolbar courseId={courseId} />
      <Suspense fallback={<AppNestedRouteLoadingSkeleton />}>
        <ManageAssignmentsTable courseId={courseId} />
      </Suspense>
    </Box>
  );
}
