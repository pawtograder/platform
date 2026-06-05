/**
 * Helpers for surfacing assignment-form validation errors on save. Kept separate
 * from the form component so the mapping/summary logic is unit-testable and can
 * be reused by the form's onInvalid handler.
 */

// Fields that live in the collapsible "Advanced settings" section. When one of
// these has a validation error on save, the section is auto-expanded so the
// highlighted field is visible.
export const ADVANCED_FIELD_KEYS = new Set<string>([
  "regrade_deadline",
  "grader_pseudonymous_mode",
  "show_leaderboard",
  "enable_repo_analytics"
]);

// Human-readable names used in the "couldn't save" error toast.
export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  slug: "Slug",
  total_points: "Points Possible",
  handout_url: "Handout URL",
  release_date: "Release Date",
  suggested_due_date: "Suggested Due Date",
  due_date: "Due Date",
  minutes_due_after_lab: "Minutes due after lab meeting",
  max_late_tokens: "Max Late Tokens",
  group_config: "Group configuration",
  min_group_size: "Minimum Group Size",
  max_group_size: "Maximum Group Size",
  allow_student_formed_groups: "Group Formation Method",
  copy_groups_from_assignment: "Copy groups from assignment",
  group_formation_deadline: "Group Formation Deadline",
  eval_config: "Self evaluation setting",
  deadline_offset: "Hours due after programming assignment",
  regrade_deadline: "Regrade Request Deadline"
};

export type InvalidFieldsSummary = {
  /** Human-readable names of the invalid fields (falls back to the raw key). */
  names: string[];
  /** True if any invalid field lives in the Advanced settings section. */
  hasAdvancedError: boolean;
};

/** Summarize a set of invalid field keys for display + accordion handling. */
export function summarizeInvalidFields(keys: readonly string[]): InvalidFieldsSummary {
  return {
    names: keys.map((key) => FIELD_LABELS[key] ?? key),
    hasAdvancedError: keys.some((key) => ADVANCED_FIELD_KEYS.has(key))
  };
}
