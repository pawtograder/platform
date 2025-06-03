"use client";

import { useMyReviewAssignments, useRubric } from "@/hooks/useAssignment";
import { Button, HStack } from "@chakra-ui/react";

import { useParams, useRouter } from "next/navigation";
import SelfReviewDueDateInformation from "./self-review-due-date-information";
export default function AssignmentSelfReviewToolbar() {
  const { course_id, assignment_id } = useParams();
  const router = useRouter();
  const assignment = useMyReviewAssignments();
  const selfReviewRubric = useRubric("self-review");
  console.log(selfReviewRubric);
  const selfReviewAssignment = assignment.find((a) => a.rubric_id === selfReviewRubric?.id);
  console.log(selfReviewAssignment);
  console.log(assignment);
  return (
    <HStack>
      <SelfReviewDueDateInformation />
      {selfReviewAssignment && (
        <Button
          colorPalette="green"
          onClick={() => {
            router.push(
              `/course/${course_id}/assignments/${assignment_id}/submissions/${selfReviewAssignment.submission_id}/files?review_assignment_id=${selfReviewAssignment.id}`
            );
          }}
        >
          Self Review
        </Button>
      )}
    </HStack>
  );
}
