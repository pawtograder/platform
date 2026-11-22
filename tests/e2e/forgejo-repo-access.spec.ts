/**
 * CW-20 (#1113): a student whose Forgejo repo isn't ready yet sees "waiting for access" as plain
 * text, not a link that 404s. Once the row turns ready, the repo is a link to the Forgejo instance.
 */
import { expect, test } from "../global-setup";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  loginAsUser,
  setCourseFeature,
  supabase,
  type TestingUser
} from "./TestingUtils";

const FORGEJO_URL = "https://forgejo.e2e.invalid";

test.describe("Forgejo repo access on the assignment page", () => {
  test.describe.configure({ timeout: 180_000 });
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const repoName = `e2e-ignore/fj-access-${suffix}`;
  let course: Awaited<ReturnType<typeof createClass>>;
  let student: TestingUser;
  let assignment: { id: number };
  let repositoryId: number;

  test.beforeAll(async () => {
    course = await createClass({ name: `E2E Forgejo Access ${suffix}` });
    await setCourseFeature(course.id, "cloud-workspaces", true);
    student = await createUserInClass({ role: "student", class_id: course.id });
    assignment = await insertAssignment({
      class_id: course.id,
      due_date: addDays(new Date(), 14).toISOString(),
      name: `Forgejo Access HW ${suffix}`,
      assignment_slug: `fj-access-${suffix}`,
      git_provider: "forgejo"
    });
    // The student's Forgejo account, which is where the repo link points.
    const account = await supabase.from("git_accounts").insert({
      user_id: student.user_id,
      provider: "forgejo",
      instance_url: FORGEJO_URL,
      login: `fj-${suffix}`,
      remote_user_id: Math.floor(Math.random() * 1_000_000_000)
    });
    expect(account.error).toBeNull();
    // The reconciler inserts the row before Forgejo has created the repo and granted access.
    const repo = await supabase
      .from("repositories")
      .insert({
        class_id: course.id,
        assignment_id: assignment.id,
        profile_id: student.private_profile_id,
        repository: repoName,
        git_provider: "forgejo",
        is_github_ready: false
      })
      .select("id")
      .single();
    expect(repo.error).toBeNull();
    repositoryId = repo.data!.id;
  });

  test("shows 'waiting for access' with no link, then the link once the repo is ready", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments/${assignment.id}`);

    await expect(page.getByText(`${repoName} (waiting for access)`)).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(repoName) })).toHaveCount(0);

    const ready = await supabase.from("repositories").update({ is_github_ready: true }).eq("id", repositoryId);
    expect(ready.error).toBeNull();
    await page.reload();

    const link = page.getByRole("link", { name: `${repoName} (ready ✅)` });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", `${FORGEJO_URL}/${repoName}`);
    await expect(page.getByText("(waiting for access)")).toHaveCount(0);
  });
});
