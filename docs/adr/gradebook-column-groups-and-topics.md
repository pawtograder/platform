# ADR: Gradebook column groups and topics

Status: accepted, October 2026. Groups ship first; topics follow in a second change.

## Context

The gradebook showed columns in collapsible groups, but no group was stored anywhere. The browser
computed groups on every render in `gradebookTable.tsx` and again in `whatIf.tsx`: split the slug on
`-`, take a prefix, and start a new group wherever `sort_order` was not exactly the previous value
plus one. Instructors could not create, rename, or move a group, and the heuristic made four
mistakes in the seeded CS 4535 gradebook alone:

- a deleted column left a hole in `sort_order` that split Quiz into two groups;
- headers took the first slug token, so "AI Usage Log 1" sat under "Ais";
- a column with a NULL `sort_order` (code-walk columns) counted as position 0 and split Assignment 1 off;
- collapse state was keyed by display name, so two groups that shared a name collapsed together.

In Fall 2026 every student in CS 4535 implemented first-class column groups independently, as a
pull request that never merged. Those twelve designs, and a replay harness that ran each one against
the same seeded and constructed gradebooks, are the evidence behind each decision below. Credit is
by GitHub handle and pull request number in `neu-cs4535/fa26-handout-hw1-onboarding`.

## Decision: groups

**A group is a row; membership is a column on `gradebook_columns`.** The new table is
`gradebook_column_groups (id, class_id, gradebook_id, name)`, and `gradebook_columns.group_id` is
nullable. Every submission put membership on the column rather than in a join table. NULL means
ungrouped; deleting a group sets its columns' `group_id` to NULL and never touches a grade
(naman0r #2, DavidCzartoryski #4, rishidil #12, adhirajpuri25 #13, wongcolin45 #14).

**The database rejects a cross-course grouping.** A composite foreign key
`(group_id, gradebook_id) → gradebook_column_groups (id, gradebook_id)` means a column can join
only a group of its own gradebook, and the group's `(gradebook_id, class_id)` key into `gradebooks`
pins its class. This is the form used by DavidCzartoryski #4, adhirajpuri25 #13 and wongcolin45 #14;
nourshoreibah #1 introduced the first composite foreign key in the class.

**Group names are unique per gradebook, ignoring case** (DavidCzartoryski #4). The collapse bug
came from groups sharing a name, and the client now keys collapse state by group id.

**There is one order, `sort_order`, and a group is drawn at its first member.** We considered a
separate group order with a position inside each group (nourshoreibah #1), which makes a torn
group impossible to express. It would also have meant rewriting every consumer of `sort_order`:
the move, reorder and auto-layout RPCs, the sort-order trigger, drag-and-drop, and CSV export.
Instead every write path keeps a group's members contiguous, and the renderer draws a group at
the position of its first member, so a group torn by an older client or a direct write still shows
as one group (DavidCzartoryski #4). The reorder and auto-layout RPCs now finish by compacting
groups, so any reorder repairs a torn group.

**Empty groups delete themselves, one at a time.** A trigger deletes the group a column just left
when no column remains in it (DavidCzartoryski #4). It deliberately considers no other group: a
submission that deleted "every empty group the caller can reach" deleted other courses' groups.

**Writes go through narrow paths.** Students and graders cannot write groups. Instructors create
groups only through an RPC, so a group never starts empty, and may update only the name
(DavidCzartoryski #4's column grant). Membership changes go through `gradebook_columns_set_group`,
which places moved columns contiguously; the RPC shape follows naman0r #2 and whoisaldo #5.

**A student sees a group only if they can see one of its columns.** The policy uses the same
inline `user_privileges` form as the current `gradebook_columns` policy, plus an explicit
visible-column test. Four submissions reused the older class-membership policy and exposed the name
of a group made only of instructor-only columns; nourshoreibah #1, Aryan0102 #7 and linacodess #16
stated the visibility predicate explicitly. Realtime follows the same rule: staff receive the row,
and students receive only the id and refetch it through RLS.

**Existing gradebooks keep today's display until an instructor turns groups on.** Groups are the
`gradebook-column-groups` course feature. The migration writes it as disabled for every existing
class, so no existing gradebook changes on deploy. Classes created later default to enabled. The
old heuristic is kept, unchanged, as `legacySlugLayout()` for classes still on it.

**Turning groups on previews an auto-group rule and lists every change.** The rule is a faithful
port of the heuristic with three corrections, and the preview lists every column whose header
would differ from today, with the reason. That every departure is listed and checked comes from
nourshoreibah #1's self-checking backfill, which DavidCzartoryski #4 adopted and credited.

| Correction                    | Rule                                                                                                       | Found by                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Gaps no longer split a family | A run ends only where the family changes in display order                                                  | nourshoreibah #1, DavidCzartoryski #4, rishidil #12, and five others |
| Names come from the columns   | Use the members' common name prefix when today's header misspells its first word ("Ais" → "AI Usage Logs") | DavidCzartoryski #4, rishidil #12, adhirajpuri25 #13                 |
| NULL `sort_order` goes last   | Renumber such columns after the maximum, as the sort-order trigger already does                            | DavidCzartoryski #4; Aryan0102 #7 and rishidil #12 found it too      |

A run of one column stays ungrouped, which is how it renders today. Columns created after groups are
on start ungrouped; the instructor picks a group in Add Column or Edit Column (linacodess #16's
picker), or runs "Auto-group ungrouped columns".

We tested the rule against the column lists of every active Fall 2026 and Spring 2026 course. The
first version took names from the columns whenever they shared a prefix, which renamed
"Participation" to "Participation Lecs" in one course; the rule now applies only when today's
header misspells the word.

## Consequences

- No existing gradebook changes until its instructor turns the feature on and confirms the preview.
- The slug heuristic stays in the codebase until no active course uses it.
- Score expressions such as `gradebook_columns("skill-*")` still match slugs; groups are display only.
- Dragging a column out of its expanded group puts it back, because compaction pulls it to its
  group. Moving a column out of a group is done from the column menu.
- `broadcast_gradebook_columns_change` already sends full rows of instructor-only columns to every
  student's channel. That is a separate issue and is not fixed here.

## Down path

`supabase/migrations/20261028120000_gradebook_column_groups.down.sql.txt`, run by hand. It drops
the table before `group_id`, because the table's policy reads that column; two submissions' down
scripts failed on that ordering.
