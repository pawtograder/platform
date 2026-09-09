/**
 * The repo_mode matrix the repo reconciler acts on.
 *
 * `assignmentShouldHaveRepos` decides whether a NULL `template_repo` / `autograder.grader_repo` is
 * a failure to repair or the correct state. Getting it wrong in either direction is expensive: too
 * narrow and a broken assignment stays broken and unreported; too wide and the reconciler creates
 * GitHub repos every 15 minutes for assignments that are supposed to have none.
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { assignmentShouldHaveRepos, resolveHandoutRepoAction } from "./handoutRepoStrategy.ts";

Deno.test("assignmentShouldHaveRepos: modes that opt out of GitHub entirely", () => {
  // assignment-create-handout-repo CLEARS template_repo for these, so NULL is correct and must
  // never be repaired.
  assertEquals(assignmentShouldHaveRepos("none"), false);
  assertEquals(assignmentShouldHaveRepos("no_submission"), false);
});

Deno.test("assignmentShouldHaveRepos: modes that create a handout", () => {
  assertEquals(assignmentShouldHaveRepos("template_only_staff"), true);
  assertEquals(assignmentShouldHaveRepos("template_with_student_forks"), true);
});

Deno.test("assignmentShouldHaveRepos: fork_from_prior_assignment inherits but still expects a pointer", () => {
  // No repo is CREATED for this mode, but template_repo is copied from the source assignment, so a
  // NULL pointer is still a defect — and re-invoking the function is still the right repair,
  // because it takes the inherit_from_source branch rather than creating anything.
  assertEquals(assignmentShouldHaveRepos("fork_from_prior_assignment"), true);
  const action = resolveHandoutRepoAction(
    { id: 2, class_id: 7, repo_mode: "fork_from_prior_assignment", source_assignment_id: 1 },
    { id: 1, class_id: 7, template_repo: "org/course-handout-hw1", latest_template_sha: "abc" }
  );
  assertEquals(action.kind, "inherit_from_source");
});

Deno.test("assignmentShouldHaveRepos agrees with resolveHandoutRepoAction on the no-repo modes", () => {
  // Pins the two to each other: a mode that resolves to "noop" must be a mode this reports false
  // for, or the reconciler would keep calling a function that deliberately does nothing.
  for (const mode of ["none", "no_submission"] as const) {
    const action = resolveHandoutRepoAction({ id: 1, class_id: 1, repo_mode: mode, source_assignment_id: null }, null);
    assertEquals(action.kind, "noop");
    assertEquals(assignmentShouldHaveRepos(mode), false);
  }
});
