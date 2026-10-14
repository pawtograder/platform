"use client";

import { useAssignments } from "@/hooks/useCourseController";

/**
 * Whether to prompt for GitHub linking and org invitations. The git host is chosen per assignment,
 * so a Forgejo assignment's page never asks, and course-wide pages ask only while some assignment
 * still gets GitHub repos (or none exist yet, which keeps today's behavior for new classes).
 */
export function useNeedsGitHubAccount(assignmentGitProvider?: string | null): boolean {
  const assignments = useAssignments();
  if (assignmentGitProvider) {
    return assignmentGitProvider === "github";
  }
  const repoAssignments = assignments.filter((a) => a.repo_mode !== "none" && a.repo_mode !== "no_submission");
  return repoAssignments.length === 0 || repoAssignments.some((a) => a.git_provider === "github");
}
