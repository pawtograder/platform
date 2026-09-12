/**
 * The repo_mode matrix the repo reconciler acts on.
 *
 * `assignmentShouldHaveRepos` decides whether a NULL `template_repo` / `autograder.grader_repo` is
 * a failure to repair or the correct state. Getting it wrong in either direction is expensive: too
 * narrow and a broken assignment stays broken and unreported; too wide and the reconciler creates
 * GitHub repos every 15 minutes for assignments that are supposed to have none.
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  assignmentShouldHaveRepos,
  expectedHandoutRepo,
  handoutPointerIsOurs,
  resolveHandoutRepoAction
} from "./handoutRepoStrategy.ts";

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

Deno.test("expectedHandoutRepo: template modes derive <org>/<class>-handout-<assignment>", () => {
  for (const mode of ["template_only_staff", "template_with_student_forks"] as const) {
    assertEquals(
      expectedHandoutRepo({
        mode,
        githubOrg: "khoury-cs3100",
        classSlug: "sp26",
        assignmentSlug: "hw2",
        sourceTemplateRepo: null
      }),
      "khoury-cs3100/sp26-handout-hw2"
    );
  }
});

Deno.test("expectedHandoutRepo: fork_from_prior_assignment answers with the SOURCE's handout", () => {
  // The regression this function exists for. The inherited pointer names the source assignment's
  // handout and can never equal this assignment's derived name, so comparing against the derived
  // name classified it as a custom handout — and the reconciler then ran solution creation only,
  // publishing grader_repo and taking the assignment out of every future scan with its workflow_sha
  // still NULL.
  assertEquals(
    expectedHandoutRepo({
      mode: "fork_from_prior_assignment",
      githubOrg: "khoury-cs3100",
      classSlug: "sp26",
      assignmentSlug: "hw2",
      sourceTemplateRepo: "khoury-cs3100/sp26-handout-hw1"
    }),
    "khoury-cs3100/sp26-handout-hw1"
  );
  // Never the derived name, which is what the old rule compared against.
  assertEquals(
    expectedHandoutRepo({
      mode: "fork_from_prior_assignment",
      githubOrg: "khoury-cs3100",
      classSlug: "sp26",
      assignmentSlug: "hw2",
      sourceTemplateRepo: "khoury-cs3100/sp26-handout-hw1"
    }) === "khoury-cs3100/sp26-handout-hw2",
    false
  );
});

Deno.test("expectedHandoutRepo: null when it cannot be determined", () => {
  // A source with no handout of its own. Null must not be read as "matches", or an assignment
  // carrying a genuinely custom pointer would be rerun and have that pointer rebuilt over.
  assertEquals(
    expectedHandoutRepo({
      mode: "fork_from_prior_assignment",
      githubOrg: "org",
      classSlug: "sp26",
      assignmentSlug: "hw2",
      sourceTemplateRepo: null
    }),
    null
  );
  // Missing naming inputs, rather than a name with "undefined" in it.
  assertEquals(
    expectedHandoutRepo({
      mode: "template_only_staff",
      githubOrg: null,
      classSlug: "sp26",
      assignmentSlug: "hw2",
      sourceTemplateRepo: null
    }),
    null
  );
  assertEquals(
    expectedHandoutRepo({
      mode: "template_only_staff",
      githubOrg: "org",
      classSlug: "sp26",
      assignmentSlug: undefined,
      sourceTemplateRepo: null
    }),
    null
  );
});

Deno.test("expectedHandoutRepo: no-repo modes have no expected handout", () => {
  // These CLEAR template_repo, so there is no pointer to match and nothing to rerun.
  for (const mode of ["none", "no_submission"] as const) {
    assertEquals(
      expectedHandoutRepo({
        mode,
        githubOrg: "org",
        classSlug: "sp26",
        assignmentSlug: "hw2",
        sourceTemplateRepo: null
      }),
      null
    );
    assertEquals(assignmentShouldHaveRepos(mode), false);
  }
});

Deno.test("handoutPointerIsOurs: exact, case-insensitive, and the two null cases", () => {
  assertEquals(handoutPointerIsOurs("org/c-handout-hw2", "org/c-handout-hw2"), true);
  // A class whose stored github_org differs only in case from the owner already in template_repo.
  // GitHub logins are case-insensitive but classes.github_org keeps the typed capitalization, so
  // these name the same repository; calling it custom would leave the assignment unrepaired.
  assertEquals(handoutPointerIsOurs("Khoury-CS3650/C-Handout-HW2", "khoury-cs3650/c-handout-hw2"), true);
  // A genuinely different repository is still protected.
  assertEquals(handoutPointerIsOurs("org/instructors-own-handout", "org/c-handout-hw2"), false);
  // Nothing stored: nothing to protect, safe to create.
  assertEquals(handoutPointerIsOurs(null, "org/c-handout-hw2"), true);
  // Unresolvable expectation with a pointer present: must NOT be read as a match.
  assertEquals(handoutPointerIsOurs("org/c-handout-hw1", null), false);
  assertEquals(handoutPointerIsOurs(null, null), true);
});
