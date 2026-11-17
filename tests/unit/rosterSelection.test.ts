/**
 * Roster selection (#1092): rows are rebuilt when Forgejo or Discord data changes, so a selection made
 * before a rebuild must still be removable after it.
 */
import { setRowChecked, type SelectableRow } from "@/app/course/[course_id]/manage/course/enrollments/rosterSelection";

const enrollment = (profile: string): SelectableRow => ({ type: "enrollment", private_profile_id: profile });

test("unchecking a rebuilt row removes the copy selected before the rebuild", () => {
  const selected = new Set<SelectableRow>();
  setRowChecked(selected, enrollment("p1"), true);
  setRowChecked(selected, enrollment("p1"), false);
  expect(selected.size).toBe(0);
});

test("checking a rebuilt row keeps one entry per row, and invitations and enrollments don't collide", () => {
  const selected = new Set<SelectableRow>();
  setRowChecked(selected, enrollment("p1"), true);
  setRowChecked(selected, enrollment("p1"), true);
  setRowChecked(selected, { type: "invitation", id: 1 }, true);
  setRowChecked(selected, enrollment("1"), true);
  expect(selected.size).toBe(3);
});
