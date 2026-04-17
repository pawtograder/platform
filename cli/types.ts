/**
 * Shared types for the Pawtograder CLI
 */

// CSV row type for schedule-based copy operations
export interface AssignmentScheduleRow {
  assignment_slug?: string;
  assignment_title?: string;
  release_date?: string;
  due_date?: string;
  latest_due_date?: string;
}
