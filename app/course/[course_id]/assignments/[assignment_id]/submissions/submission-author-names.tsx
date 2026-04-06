import { useAssignmentScopedGroupsQuery, useSubmissionsQuery } from "@/hooks/assignment-data";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { Skeleton, Text } from "@chakra-ui/react";
import { useMemo } from "react";

export default function SubmissionAuthorNames({ submission_id }: { submission_id: number }) {
  const { data: submissions = [] } = useSubmissionsQuery();
  const submission = useMemo(() => submissions.find((s) => s.id === submission_id), [submissions, submission_id]);
  const authorProfile = useUserProfile(submission?.profile_id);
  const { data: assignmentGroups = [] } = useAssignmentScopedGroupsQuery();
  const groupInfo = useMemo(
    () => assignmentGroups.find((g) => g.id === submission?.assignment_group_id),
    [assignmentGroups, submission?.assignment_group_id]
  );
  if (!submission || (!authorProfile && !groupInfo)) {
    return <Skeleton />;
  }
  if (authorProfile) {
    return <Text>{authorProfile?.name}</Text>;
  }
  return <Text>{groupInfo?.name}</Text>;
}
