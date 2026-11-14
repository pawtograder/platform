# ADR: Gradebook column groups and topics

Status: accepted, October 2026. Groups ship first; topics follow in a second change that builds on them.

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
pull request that never merged. Those thirteen designs, and a replay harness that ran each one against
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

## Decision: topics

The second half of the bake-off asked what the gradebook should do for CS 2100, where every topic
is assessed several times. Twelve proposals answered it. We checked them against CS 2100's own
gradebooks in production (Fall 2025 through Fall 2026), which have exactly the shape the proposals
assumed: 13 or 14 topics, two or three columns named "Attempt N: Topic" per topic, and a hand-written
`topic_*` column per topic that takes the maximum of its attempts.

**A topic is a second axis, not a kind of group.** A group is a partition, so it can express one of
the two axes such a gradebook has, either the topic or the occasion (one quiz assesses several
topics), but never both (DavidCzartoryski #4; rishidil #12 and wongcolin45 #14 made the same point).
CS 2100 imports scores one quiz session at a time, so the session is the group, and the topic is
stored separately: `gradebook_topics`, with `gradebook_columns.topic_id` and `attempt_number`.

**The constraints make a broken topic impossible to express.** `topic_id` and `attempt_number` are
set together, and the attempt number is positive (nourshoreibah #1). `UNIQUE (topic_id,
attempt_number)` rules out two attempt 2s at one topic; five submissions converged on it
(nourshoreibah #1, DavidCzartoryski #4, rishidil #12, adhirajpuri25 #13, wongcolin45 #14). The CS
2100 Spring 2026 gradebook contains exactly that case: two "Attempt 2: Stakeholder-value Matrices"
columns. A composite foreign key keeps a column's topic inside its own gradebook.

**One topic per column.** whoisaldo #5, somshrivastava #10 and zhiruichengit #17 asked whether one
assessment can measure several topics. In CS 2100 it cannot: each topic of a quiz session is its own
column. Membership is therefore a column on `gradebook_columns`, not a table carrying a role.

**A topic's standing is an ordinary computed column.** The topic points at it through
`standing_column_id`, so standings use the one recalculation pipeline that every other column uses
(nourshoreibah #1; wongcolin45 #14's `rollup_column_id`). `standing_rule` is either NULL, meaning
the column keeps the instructor's own expression, or `best` or `latest`, in which case its expression
is generated from the topic's attempts and regenerated whenever an attempt joins, leaves, or is
renumbered (DavidCzartoryski #4).

The generated expression exists because of two problems found in the same place. DavidCzartoryski #4
showed that the expression functions treat a missing attempt differently (`max` skips it, `mean`
counts it as 0), so two hand-written standings can disagree about the same attempt without anyone
noticing. In production, seven third attempts in CS 2100 Spring 2026 (`3cce`, `3ci`, ...) did not
match their topic's slug glob (`cce*`), so a hand-written `max` would have ignored them. The
generated expression lists every attempt by slug. It follows nourshoreibah #1's defaults: excused
attempts are excluded, missing attempts are skipped, and a topic with no eligible attempt has no
score. Every CS 2100 term so far uses best-of, so `best` and `latest` are the only rules; cumulative
credit (nourshoreibah #1) waits for a course that needs it.

**The display collapses a topic to its standing.** In topic view, a topic is one unit drawn where its
standing column sits; collapsed, it shows the standing, and expanded, the attempts in order
(DavidCzartoryski #4, wongcolin45 #14, rishidil #12). A collapsed group shows the latest column
anyone has a score in, which for a topic would be the most recent attempt and not each student's
standing (wongcolin45 #14, AbhinavGonthina #6). Columns outside any topic keep the group layout, and
the group view is a toggle away. Students see the same units in What-If.

**Topics are suggested, never inferred silently.** Suggest topics treats a computed column whose
inputs are only manual columns, read by nothing else, as a topic's standing, and those inputs as its
attempts (DavidCzartoryski #4's inference). It takes attempt numbers from "Attempt N" names and
proposes, by name, attempts that the standing does not read, which recovers the glob-missed third
attempts. Nothing is written until the instructor confirms the proposed set, and a duplicate attempt
blocks applying until one column is unchecked (nourshoreibah #1, wongcolin45 #14, whoisaldo #5).
Applying keeps each standing's existing expression, so no grade changes. On CS 2100 Spring 2026 it
proposes all 13 topics and all seven third attempts, and reports the duplicate attempt 2.

**Topics are the `gradebook-topics` course feature**, rolled out like groups: disabled for existing
classes, enabled by default for new ones. There is nothing to backfill.

Deferred: topic membership carrying a role or spanning several topics (whoisaldo #5), cumulative
credit and copying a confirmed setup into the next term (nourshoreibah #1), the transposed
topic-by-attempt grid per student (nourshoreibah #1, adhirajpuri25 #13), and pagination for large
rosters.

## Consequences

- No existing gradebook changes until its instructor turns the feature on and confirms the preview.
- The slug heuristic stays in the codebase until no active course uses it.
- Score expressions such as `gradebook_columns("skill-*")` still match slugs; groups are display only.
- Dragging a column out of its expanded group puts it back, because compaction pulls it to its
  group. Moving a column out of a group is done from the column menu.
- `broadcast_gradebook_columns_change` already sends full rows of instructor-only columns to every
  student's channel. That is a separate issue and is not fixed here.

## Down path

Run by hand, topics first:
`supabase/migrations/20261110130000_gradebook_topics.down.sql.txt`, then
`supabase/migrations/20261110120000_gradebook_column_groups.down.sql.txt`. Each drops its table
before the `gradebook_columns` column that the table's policy reads; two submissions' down scripts
failed on that ordering. Standing columns stay, keeping their last expression.
