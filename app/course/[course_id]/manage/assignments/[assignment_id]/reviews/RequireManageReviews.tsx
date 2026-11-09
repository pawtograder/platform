"use client";

import { useCapabilityOnceLoaded } from "@/hooks/useClassProfiles";
import { Box, Spinner } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Bulk Assign and Reassign are only actions, so someone without manage_review_assignments is sent
 * back to Grading Assignments instead of seeing an empty form (#1010).
 */
export default function RequireManageReviews({ children }: { children: React.ReactNode }) {
  const { course_id, assignment_id } = useParams();
  const router = useRouter();
  const canManageReviews = useCapabilityOnceLoaded("manage_review_assignments");
  const reviewsHref = `/course/${course_id}/manage/assignments/${assignment_id}/reviews`;

  useEffect(() => {
    if (canManageReviews === false) {
      router.replace(reviewsHref);
    }
  }, [canManageReviews, reviewsHref, router]);

  if (!canManageReviews) {
    return (
      <Box p={4}>
        <Spinner />
      </Box>
    );
  }
  return <>{children}</>;
}
