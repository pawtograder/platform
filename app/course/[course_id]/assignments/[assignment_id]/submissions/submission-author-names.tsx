import { useAssignmentGroup, useSubmission } from "@/hooks/useAssignment";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Skeleton, Text } from "@chakra-ui/react";

export default function SubmissionAuthorNames({ submission_id }: { submission_id: number }) {
  const submission = useSubmission(submission_id);
  const authorProfile = useUserProfile(submission?.profile_id);
  const groupInfo = useAssignmentGroup(submission?.assignment_group_id);
  if (!submission || (!authorProfile && !groupInfo)) {
    return <Skeleton />;
  }
  if (authorProfile) {
    return <Text>{authorProfile?.name}</Text>;
  }
  return <Text>{groupInfo?.name}</Text>;
}
