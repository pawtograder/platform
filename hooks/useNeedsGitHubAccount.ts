"use client";

import { useAssignments, useCourse } from "@/hooks/useCourseController";
import { needsGitHubPrompts } from "@/lib/gitProviderOptions";

/**
 * Whether to show the GitHub link and organization invitation prompts. Pass the assignment's
 * `git_provider` on an assignment page; leave it out on course pages. Requires CourseControllerProvider.
 */
export function useNeedsGitHubAccount(assignmentGitProvider?: string | null): boolean {
  const assignments = useAssignments();
  const course = useCourse();
  return needsGitHubPrompts(course.github_org, assignments, assignmentGitProvider);
}
