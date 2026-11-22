import { randomInt } from "node:crypto";
import { expect, test } from "../global-setup";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  supabase
} from "./TestingUtils";

test("a Forgejo submission links its commit to the Forgejo host", async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  const host = "https://forgejo.example.test";
  const repository = `e2e-ignore/commit-links-${suffix}`;
  const sha = "af24bdd12345678901234567890123456789012345";
  const course = await createClass({ name: `Forgejo commit links ${suffix}` });
  await setCourseFeature(course.id, "cloud-workspaces", true);
  const student = await createUserInClass({ role: "student", class_id: course.id });
  const assignment = await insertAssignment({
    class_id: course.id,
    due_date: new Date(Date.now() + 14 * 86400000).toISOString(),
    name: `Forgejo commits ${suffix}`,
    assignment_slug: `fj-commits-${suffix}`,
    git_provider: "forgejo"
  });
  expect(
    (
      await supabase.from("git_accounts").insert({
        user_id: student.user_id,
        provider: "forgejo",
        instance_url: host,
        login: `fj-${suffix}`,
        remote_user_id: randomInt(1_000_000_000)
      })
    ).error
  ).toBeNull();
  const repo = await supabase
    .from("repositories")
    .insert({
      class_id: course.id,
      assignment_id: assignment.id,
      profile_id: student.private_profile_id,
      repository,
      git_provider: "forgejo",
      is_github_ready: true
    })
    .select("id")
    .single();
  expect(repo.error).toBeNull();
  const submission = await supabase
    .from("submissions")
    .insert({
      class_id: course.id,
      assignment_id: assignment.id,
      profile_id: student.private_profile_id,
      repository_id: repo.data!.id,
      repository,
      sha,
      submitted_via: "git",
      run_number: 1,
      run_attempt: 1
    })
    .select("id")
    .single();
  expect(submission.error).toBeNull();
  await loginAsUser(page, student, course);
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission.data!.id}/files`);
  const commit = page.getByRole("link", { name: `Commit ${sha.slice(0, 7)}`, exact: true }).filter({ visible: true });
  await expect(commit).toHaveAttribute("href", `${host}/${repository}/commit/${sha}`, { timeout: 60_000 });
  await expect(page.locator(`a[href^="https://github.com/${repository}/commit/"]`)).toHaveCount(0);
});
