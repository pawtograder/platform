import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(180_000);

// The create-class form populates its GitHub-org dropdown from the
// `list-github-orgs` edge function, which talks to the real GitHub App. We stub
// that network call so the dropdown is deterministic and the test does not
// depend on which orgs the App happens to be installed on (or on GitHub being
// reachable at all). See project notes on E2E + GitHub App.
const MOCK_ORG = "pawtograder-playground";
const MOCK_INSTALL_URL = "https://github.com/apps/pawtograder/installations/new";

let homeCourse: Course;
let adminUser: TestingUser | undefined;
let existingInstructor: TestingUser | undefined;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  homeCourse = await createClass({ name: "Admin Create Class Home" });
  [adminUser, existingInstructor] = await createUsersInClass([
    {
      name: "Admin Portal User",
      public_profile_name: "Admin Portal Pseudonym",
      email: "admin-create-class-admin@pawtograder.net",
      role: "instructor",
      class_id: homeCourse.id,
      useMagicLink: true
    },
    {
      name: "Existing Course Instructor",
      public_profile_name: "Existing Course Instructor Pseudonym",
      email: "admin-create-class-existing-instructor@pawtograder.net",
      role: "instructor",
      class_id: homeCourse.id,
      useMagicLink: true
    }
  ]);

  // Promote the admin user to the platform `admin` role so they can reach the
  // /admin portal and call admin_* RPCs.
  const { error } = await supabase
    .from("user_roles")
    .update({ role: "admin" })
    .eq("user_id", adminUser!.user_id)
    .eq("class_id", homeCourse.id);
  if (error) {
    throw new Error(`Failed to promote admin user: ${error.message}`);
  }
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([adminUser, existingInstructor]);
});

test.describe("Admin Create Class workflow", () => {
  test.describe.configure({ mode: "serial" });

  test("admin_lookup_user_by_email returns most-recent private-profile name, or no rows", async () => {
    const adminClient = await createAuthenticatedClient(adminUser!);

    // Matched user -> exactly one row carrying their private profile name.
    const { data: matched, error: matchedError } = await adminClient.rpc("admin_lookup_user_by_email", {
      p_email: existingInstructor!.email
    });
    expect(matchedError).toBeNull();
    expect(matched).toHaveLength(1);
    expect(matched![0].user_id).toBe(existingInstructor!.user_id);
    expect(matched![0].name).toBe(existingInstructor!.private_profile_name);

    // Case-insensitive: GoTrue stores emails lowercased, so an admin who types a
    // different case must still match the existing user (otherwise enrollment
    // would try to create a duplicate auth user and silently fail).
    const { data: upperMatched, error: upperError } = await adminClient.rpc("admin_lookup_user_by_email", {
      p_email: existingInstructor!.email.toUpperCase()
    });
    expect(upperError).toBeNull();
    expect(upperMatched).toHaveLength(1);
    expect(upperMatched![0].user_id).toBe(existingInstructor!.user_id);

    // Unknown email -> no rows (frontend treats this as "no match").
    const { data: unmatched, error: unmatchedError } = await adminClient.rpc("admin_lookup_user_by_email", {
      p_email: `nobody-${Date.now()}@pawtograder.net`
    });
    expect(unmatchedError).toBeNull();
    expect(unmatched ?? []).toHaveLength(0);

    // Non-admins are denied (existingInstructor is only an instructor).
    const instructorClient = await createAuthenticatedClient(existingInstructor!);
    const { error: deniedError } = await instructorClient.rpc("admin_lookup_user_by_email", {
      p_email: existingInstructor!.email
    });
    expect(deniedError).not.toBeNull();
  });

  test("setting github_org/slug on an unconfigured class enqueues a team resync", async () => {
    // A class can exist without GitHub config (e.g. SIS import). Enrollment-time
    // team sync no-ops for it (20260611120001), so when it later becomes
    // GitHub-configured we must backfill via a resync trigger
    // (20260615120000). Verify the NULL->set transition enqueues both team syncs.
    const { data: cls, error: insertError } = await supabase
      .from("classes")
      .insert({
        name: `E2E Resync ${Date.now()}`,
        // slug present but github_org NULL => class is not yet GitHub-configured.
        // e2e-ignore- prefix makes the async worker skip the real GitHub call.
        slug: `e2e-ignore-resync-${Date.now()}`,
        github_org: null,
        start_date: new Date().toISOString(),
        end_date: new Date(Date.now() + 86_400_000).toISOString(),
        late_tokens_per_student: 10,
        time_zone: "America/New_York"
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`Failed to insert unconfigured class: ${insertError.message}`);
    const classId = cls!.id;

    // Flip the class to GitHub-configured.
    const { error: updateError } = await supabase
      .from("classes")
      .update({ github_org: "pawtograder-playground" })
      .eq("id", classId);
    if (updateError) throw new Error(`Failed to configure class org: ${updateError.message}`);

    // The trigger enqueues a staff + student resync, each logged to
    // api_gateway_calls with our debug_id.
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("api_gateway_calls")
            .select("method")
            .eq("class_id", classId)
            .eq("debug_id", "class_config_resync");
          return (data ?? []).map((r) => r.method).sort();
        },
        { timeout: 30_000 }
      )
      .toEqual(["sync_staff_team", "sync_student_team"]);
  });

  test("admin creates a class with a selected org and pre-filled + new instructors", async ({ page }) => {
    const className = `E2E Admin Created ${Date.now()}`;
    const newInstructorEmail = `admin-create-class-new-instructor-${Date.now()}@pawtograder.net`;
    const newInstructorName = "Brand New Instructor";

    // Stub the org-list edge function (incl. CORS preflight).
    await page.route("**/functions/v1/list-github-orgs", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "*"
          }
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          orgs: [{ login: MOCK_ORG, installationId: 42 }],
          installUrl: MOCK_INSTALL_URL
        })
      });
    });

    await loginAsUser(page, adminUser!);
    await page.goto("/admin/classes");
    await expect(page.getByRole("heading", { name: "Class Management" })).toBeVisible();

    // The page is server-rendered, so the trigger's click handler may not be
    // hydrated yet when the heading first appears. Retry the open click until
    // the dialog actually shows (without re-clicking if it's already open).
    const createTrigger = page.getByRole("button", { name: "Create Manually" });
    const dialogTitle = page.getByText("Create New Class");
    await expect(async () => {
      if (!(await dialogTitle.isVisible())) {
        await createTrigger.click();
      }
      await expect(dialogTitle).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });

    await page.locator("#name").fill(className);
    // Template prefix (slug) is required: staff enrollment triggers a GitHub team
    // sync that needs both org and slug on the class.
    await page.locator("#github_template_prefix").fill("hw");

    // The org dropdown is required and populated from the stubbed edge function.
    await expect(page.locator("#github_org_name")).toBeVisible();
    await page.locator("#github_org_name").selectOption(MOCK_ORG);

    // Row 1: an existing user -> name auto-fills from their most recent profile.
    const emailInputs = page.getByPlaceholder("instructor@northeastern.edu");
    const nameInputs = page.getByPlaceholder("Full name");
    await emailInputs.nth(0).fill(existingInstructor!.email);
    await emailInputs.nth(0).blur();
    await expect(page.getByText("Matched existing user")).toBeVisible();
    await expect(nameInputs.nth(0)).toHaveValue(existingInstructor!.private_profile_name);

    // Row 2: a brand-new email -> "no match", admin types the name.
    await page.getByRole("button", { name: "Add instructor" }).click();
    await emailInputs.nth(1).fill(newInstructorEmail);
    await emailInputs.nth(1).blur();
    await expect(page.getByText("No match — enter name manually")).toBeVisible();
    await nameInputs.nth(1).fill(newInstructorName);

    await page.getByRole("button", { name: "Create Class" }).click();

    // The class is created synchronously; instructors are enrolled right after.
    // Poll the DB for the final state rather than racing the page reload.
    let newClassId: number | undefined;
    await expect
      .poll(
        async () => {
          const { data } = await supabase.from("classes").select("id, github_org").eq("name", className).maybeSingle();
          newClassId = data?.id;
          return data?.github_org ?? null;
        },
        { timeout: 30_000 }
      )
      .toBe(MOCK_ORG);

    expect(newClassId).toBeTruthy();

    // Both instructors land in the new class with role=instructor and the
    // expected private-profile names.
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("user_roles")
            .select("role, profiles!private_profile_id(name)")
            .eq("class_id", newClassId!)
            .eq("role", "instructor");
          return (data ?? []).map((r) => r.profiles?.name).sort();
        },
        { timeout: 60_000 }
      )
      .toEqual([newInstructorName, existingInstructor!.private_profile_name].sort());
  });
});
