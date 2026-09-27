export type AssigneeWithDisplayName = {
  private_profile_id: string;
  profiles?: {
    name?: string | null;
  } | null;
};

export type AssigneeOption<TAssignee extends AssigneeWithDisplayName> = {
  label?: string | null;
  value: TAssignee;
};

export function getAssigneeDisplayLabel(assignee: AssigneeWithDisplayName) {
  const name = assignee.profiles?.name?.trim();
  return name || assignee.private_profile_id;
}

export function getAssigneeOptionLabel<TAssignee extends AssigneeWithDisplayName>(option: AssigneeOption<TAssignee>) {
  const name = option.value.profiles?.name?.trim();
  return name || option.label?.trim() || option.value.private_profile_id;
}

export function compareAssigneeOptions<TAssignee extends AssigneeWithDisplayName>(
  a: AssigneeOption<TAssignee>,
  b: AssigneeOption<TAssignee>
) {
  const labelComparison = getAssigneeOptionLabel(a).localeCompare(getAssigneeOptionLabel(b));
  if (labelComparison !== 0) {
    return labelComparison;
  }
  return a.value.private_profile_id.localeCompare(b.value.private_profile_id);
}
