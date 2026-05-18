"use client";
import { RepositoryCommitHistoryDialog } from "@/components/assignments/commit-history-dialog";
import { Assignment, Repository } from "@/utils/supabase/DatabaseTypes";
import { CrudFilter, useList } from "@refinedev/core";

export function CommitHistoryDialog({
  assignment,
  assignment_group_id,
  profile_id
}: {
  assignment: Assignment;
  assignment_group_id: number | undefined;
  profile_id: string | undefined;
}) {
  const filters: CrudFilter[] = [{ field: "assignment_id", operator: "eq", value: assignment.id }];
  if (assignment_group_id) {
    filters.push({ field: "assignment_group_id", operator: "eq", value: assignment_group_id });
  } else {
    filters.push({ field: "profile_id", operator: "eq", value: profile_id });
  }
  const { data: repository } = useList<Repository>({ resource: "repositories", filters });
  return (
    repository &&
    repository.data.length > 0 && (
      <RepositoryCommitHistoryDialog
        courseId={assignment.class_id}
        assignmentId={assignment.id}
        repositoryId={repository.data[0].id}
        repositoryFullName={repository.data[0].repository}
        showTriggerAction={false}
      />
    )
  );
}
