/** The fields the roster's selection matches on: an invitation's id, or an enrollment's private profile. */
export type SelectableRow = { type: "invitation"; id: number } | { type: "enrollment"; private_profile_id: string };

/**
 * Rows are rebuilt whenever the roster, Discord or Forgejo data changes, so a selected row is matched by
 * its id, never by object identity: otherwise unchecking a rebuilt row couldn't remove the old one.
 */
export function selectionKey(row: SelectableRow): string {
  return row.type === "invitation" ? `invitation:${row.id}` : `enrollment:${row.private_profile_id}`;
}

/** Checks or unchecks `row`, replacing any older copy of the same row. */
export function setRowChecked<T extends SelectableRow>(selected: Set<T>, row: T, checked: boolean): void {
  const key = selectionKey(row);
  for (const box of selected) if (selectionKey(box) === key) selected.delete(box);
  if (checked) selected.add(row);
}
