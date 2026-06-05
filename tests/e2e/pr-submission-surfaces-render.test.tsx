import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";

// Render-layer ("thin UI over the data") smoke coverage for the Phase-4
// PR-submission surfaces. The DATA/RLS layer for these is already covered by
// pr-submission-surfaces.test.tsx (the queries + RLS); this suite logs in as a
// real enrolled user, navigates the actual pages, and asserts the Chakra render
// layer that sits on top:
//
//   * /submissions/:id/checks       -> the workflow run row renders (matched by head_sha).
//   * /submissions/:id/deployments  -> the deployment row renders (environment/state/link).
//   * /submissions/:id/files        -> the PR base->head diff section OR the GitHub
//                                      compare-link fallback renders.
//   * /submissions/:id/results      -> the "Manual / rubric grading" empty-state (has_autograder=false).
//   * The Checks/Deployments nav tabs show ONLY for the pr submission (isPrSubmission),
//     and the require_pr_open indicator renders for staff when configured.
//
// Fixture: a pr-mode submission repointed at a fork repo with head_sha/base_sha,
// pr_number/pr_state set; a workflow_events row matching its head_sha; a
// github_deployments row matching (repository_name, head_sha); and
// assignments.has_autograder=false so the autograder tab shows the manual-grading
// empty state rather than "autograder hasn't finished".
//
// Assertions are role/text-based and resilient (don't pin colors/badges). The PR
// Files diff falls back to the GitHub compare link when the base tree isn't
// fetchable (the local E2E mock), so we accept EITHER the inline diff or the
// fallback notice — both are produced by the same PrDiffNotice component and the
// fallback is the deterministic local outcome.
//
// Needs the PROD app server (port 3001) + functions serve (the Files diff calls
// the get-pr-base-files edge function) + the seeded DB. No real GitHub.

const RUN_PREFIX = getTestRunPrefix();
const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// PR submissions can run CI/deploy on the contributor's fork — a repo NOT in
// `repositories`. The surfaces resolve purely by (repository_name, sha).
const FORK_REPO = `some-fork/pr-render-${SAFE_ID}`;
const HEAD_SHA = `head${SAFE_ID}`;
const BASE_SHA = `base${SAFE_ID}`;
const DEPLOY_ENV = "preview";
const DEPLOY_URL = "https://example.com/pr-render-deploy";
const WORKFLOW_NAME = "CI-render";

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let prAssignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let pushAssignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let prSubmissionId: number | undefined;
let pushSubmissionId: number | undefined;

const deploymentGhId = Number(`${Date.now()}`.slice(-9)) + 31;
const deploymentStatusGhId = deploymentGhId + 4000;

test.describe("PR submission surfaces (render smoke)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    course = await createClass({ name: `PR Render ${RUN_PREFIX}` });
    student = await createUserInClass({
      role: "student",
      class_id: course.id,
      name: `PR Render Student ${RUN_PREFIX}`,
      email: `pr-render-student-${SAFE_ID}@pawtograder.net`,
      useMagicLink: true
    });
    instructor = await createUserInClass({
      role: "instructor",
      class_id: course.id,
      name: `PR Render Instructor ${RUN_PREFIX}`,
      email: `pr-render-instructor-${SAFE_ID}@pawtograder.net`,
      useMagicLink: true
    });

    // PR-mode assignment, released in the past so the student can view it, with
    // require_pr_open ON (drives the staff-only RequiredPrOpenIndicator) and
    // has_autograder=false (drives the manual-grading results empty state).
    prAssignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `PR Render Assignment ${RUN_PREFIX}`,
      assignment_slug: `pr-render-${SAFE_ID}`
    });
    const { error: aUpdErr } = await supabase
      .from("assignments")
      .update({ submission_mode: "pr", require_pr_open: true, has_autograder: false })
      .eq("id", prAssignment!.id);
    expect(aUpdErr).toBeNull();

    // A push-mode assignment + submission as the negative control for tab gating
    // (its submission must NOT show the Checks/Deployments tabs).
    pushAssignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 7).toUTCString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `Push Control Assignment ${RUN_PREFIX}`,
      assignment_slug: `push-ctl-${SAFE_ID}`
    });

    // The PR submission, repointed at the fork repo + head/base sha as a PR.
    const prebaked = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: prAssignment!.id,
      class_id: course.id,
      repositorySuffix: `pr-render-${SAFE_ID}`
    });
    prSubmissionId = prebaked.submission_id;

    const { error: subUpdErr } = await supabase
      .from("submissions")
      .update({
        repository: FORK_REPO,
        head_sha: HEAD_SHA,
        base_sha: BASE_SHA,
        sha: HEAD_SHA,
        pr_number: 7,
        pr_state: "open",
        submitted_via: "pr"
      })
      .eq("id", prSubmissionId!);
    expect(subUpdErr).toBeNull();

    // The push-mode control submission (plain snapshot — no PR fields).
    const pushPrebaked = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: pushAssignment!.id,
      class_id: course.id,
      repositorySuffix: `push-ctl-${SAFE_ID}`
    });
    pushSubmissionId = pushPrebaked.submission_id;

    // CI run (workflow_event) on the fork, matching the submission head_sha.
    const { error: weErr } = await supabase.from("workflow_events").insert({
      class_id: course.id,
      event_type: "completed",
      repository_name: FORK_REPO,
      head_sha: HEAD_SHA,
      head_branch: `pr-${SAFE_ID}`,
      workflow_name: WORKFLOW_NAME,
      workflow_run_id: deploymentGhId,
      run_number: 1,
      run_attempt: 1,
      status: "completed",
      conclusion: "success"
    });
    expect(weErr).toBeNull();

    // Deployment for the fork repo + head sha (resolved to the class via the
    // submission match — NULL repository_id path).
    const { error: depErr } = await supabase.rpc("upsert_github_deployment", {
      p_class_id: course.id,
      p_repository_name: FORK_REPO,
      p_repository_id: undefined,
      p_sha: HEAD_SHA,
      p_environment: DEPLOY_ENV,
      p_state: "success",
      p_target_url: DEPLOY_URL,
      p_github_deployment_id: deploymentGhId,
      p_github_deployment_status_id: deploymentStatusGhId,
      p_creator_login: "octocat",
      p_payload: { hello: "pr-render" }
    });
    expect(depErr).toBeNull();
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([student, instructor]);
  });

  // ---------------------------------------------------------------------------
  // Checks subpage — the workflow run row renders.
  // ---------------------------------------------------------------------------
  test("Checks subpage renders the matching workflow run row", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/checks`);

    // The page renders a Chakra Table of GitHub Actions runs. The matching run's
    // workflow_name + conclusion are in the row. (The page sorts client-side and
    // shows a "matching this submission's commit (<short sha>)" caption.)
    await expect(page.getByText(WORKFLOW_NAME)).toBeVisible({ timeout: 30_000 });
    // Conclusion badge text ("success"). Use first() — the rubric sidebar renders
    // alongside the page content, so scope to the first match rather than risk a
    // strict-mode multiple-match failure.
    await expect(page.getByText("success").first()).toBeVisible();
    // The per-run "View" link to GitHub Actions confirms the row (not just text).
    await expect(page.getByRole("link", { name: /View/ }).first()).toBeVisible();
    // It is NOT the empty state.
    await expect(page.getByText("No CI checks for this submission yet.")).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Deployments subpage — the deployment row renders (environment/state/link).
  // ---------------------------------------------------------------------------
  test("Deployments subpage renders the deployment row with environment, state and link", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/deployments`);

    await expect(page.getByText(DEPLOY_ENV)).toBeVisible({ timeout: 30_000 });
    // State badge text + the target URL (rendered as a link). first() guards
    // against the rubric sidebar contributing a stray "success" match.
    await expect(page.getByText("success").first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: new RegExp(DEPLOY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    ).toBeVisible();
    await expect(page.getByText("No deployments for this submission yet.")).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Files subpage — the PR base->head diff section OR the compare-link fallback.
  // ---------------------------------------------------------------------------
  test("Files subpage renders the PR diff notice (inline diff or GitHub compare fallback)", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/files`);

    // PrDiffNotice always renders its "Pull request submission" alert + the
    // base->head compare context when base_sha + head_sha are present.
    await expect(page.getByText("Pull request submission")).toBeVisible({ timeout: 30_000 });
    const baseShort = BASE_SHA.substring(0, 7);
    const headShort = HEAD_SHA.substring(0, 7);
    // The base (xxxxxxx) -> head (yyyyyyy) sentence.
    await expect(page.getByText(new RegExp(`${baseShort}.*${headShort}`))).toBeVisible();
    // The GitHub compare link is rendered when the submission has a repository
    // (it always does here). It is the deterministic local outcome (the base
    // tree isn't fetchable under the E2E mock, so we fall back to this link),
    // but inline diffs are also acceptable if a base tree is available.
    const compareLink = page.getByRole("link", { name: new RegExp(`${baseShort}.*${headShort}.*GitHub`, "i") });
    const inlineDiffHeading = page.getByRole("heading", { name: /Changed files/i });
    await expect(async () => {
      const compareCount = await compareLink.count();
      const inlineCount = await inlineDiffHeading.count();
      expect(compareCount + inlineCount).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
  });

  // ---------------------------------------------------------------------------
  // Results subpage — the manual/rubric grading empty-state (has_autograder=false).
  // ---------------------------------------------------------------------------
  test("Results subpage renders the manual/rubric grading empty-state (has_autograder=false)", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/results`);

    await expect(page.getByText("Manual / rubric grading")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/graded manually/i)).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Nav tab gating — Checks/Deployments only for the pr submission.
  // ---------------------------------------------------------------------------
  test("Checks/Deployments nav tabs show for the pr submission but not the push submission", async ({ page }) => {
    await loginAsUser(page, student!, course);

    // PR submission: both tabs present in the submission nav.
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/files`);
    const nav = page.getByRole("navigation", { name: "Submission tabs" });
    await expect(nav).toBeVisible({ timeout: 30_000 });
    await expect(nav.getByRole("link", { name: "Checks" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Deployments" })).toBeVisible();

    // Push submission: neither tab present (isPrSubmission is false — no
    // pr_number/pr_state, push submission_mode).
    await page.goto(`/course/${course.id}/assignments/${pushAssignment!.id}/submissions/${pushSubmissionId}/files`);
    const pushNav = page.getByRole("navigation", { name: "Submission tabs" });
    await expect(pushNav).toBeVisible({ timeout: 30_000 });
    await expect(pushNav.getByRole("link", { name: "Files" })).toBeVisible();
    await expect(pushNav.getByRole("link", { name: "Checks" })).toHaveCount(0);
    await expect(pushNav.getByRole("link", { name: "Deployments" })).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // require_pr_open indicator — staff-only, rendered when configured + PR-mode.
  // ---------------------------------------------------------------------------
  test("require_pr_open indicator renders for staff on the pr submission", async ({ page }) => {
    await loginAsUser(page, instructor!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/files`);

    // RequiredPrOpenIndicator: pr_state is "open", so it reads "Required PR open: Yes".
    await expect(page.getByText(/Required PR open:\s*Yes/i)).toBeVisible({ timeout: 30_000 });
  });

  test("require_pr_open indicator is NOT shown to the student", async ({ page }) => {
    await loginAsUser(page, student!, course);
    await page.goto(`/course/${course.id}/assignments/${prAssignment!.id}/submissions/${prSubmissionId}/files`);

    // The Files PR notice confirms the page rendered for the student...
    await expect(page.getByText("Pull request submission")).toBeVisible({ timeout: 30_000 });
    // ...but the staff-only required-PR indicator must not be present.
    await expect(page.getByText(/Required PR open:/i)).toHaveCount(0);
  });
});
