"use client";

import { useAssignments } from "@/hooks/useCourseController";

export function useNeedsGitHubAccount(assignmentGitProvider?: string | null): boolean {
  const assignments = useAssignments();
  if (assignmentGitProvider) {
    return assignmentGitProvider === "github";
  }
  const repoAssignments = assignments.filter((a) => a.repo_mode !== "none" && a.repo_mode !== "no_submission");
  return repoAssignments.length === 0 || repoAssignments.some((a) => a.git_provider === "github");
}
