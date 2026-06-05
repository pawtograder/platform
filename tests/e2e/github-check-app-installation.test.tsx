import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  getTestRunPrefix,
  insertAssignment,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// E2E coverage for the `github-check-app-installation` edge function
// (supabase/functions/github-check-app-installation/index.ts) — the live
// install-check the assignment form runs before saving a PR-mode assignment
// whose upstream/handout repo may live in a different GitHub org than the class.
//
// Request:  { repo: "owner/name", class_id }
// Response: { installed, repo_accessible, org, install_url }
// Authz:    caller must be an instructor in `class_id`.
//
// WHAT IS DETERMINISTIC LOCALLY (asserted here):
//   * Authorization — the function rejects a non-instructor and a non-enrolled
//     caller with a SecurityError (401) BEFORE touching GitHub. This is a pure
//     DB authz check (user_roles), so it is fully deterministic locally and in
//     CI regardless of GitHub credentials.
//   * Input validation — a malformed repo ("no slash") and a missing class_id
//     are rejected with a UserVisibleError (400), also before any GitHub call.
//
// WHAT IS *NOT* DETERMINISTIC LOCALLY (documented, asserted only loosely):
//   * `installed` / `repo_accessible` — these come from getOctoKit()/getRepo(),
//     which call the real GitHub API (GET /app/installations, GET /repos/...).
//     getOctoKit/getAppSlug do NOT honor the PAWTOGRADER_GITHUB_STUB seam, so
//     under the local dummy GitHub App credentials (GITHUB_APP_ID=1 + a throwaway
//     RSA key, no GITHUB_APP_SLUG) the installations call 401s/throws and the
//     handler returns a 500. We therefore do NOT assert a success-shaped body for
//     the instructor path; we only assert that IF a 200 body comes back (e.g. on
//     a CI environment with real-ish credentials) it has the documented shape,
//     and otherwise tolerate the GitHub-path error. The success path
//     (installed=true/false, repo_accessible) needs a real/seeded GitHub App and
//     cannot be made deterministic on the shared local stack.
//
// Requires (see AGENTS.md): `npx supabase functions serve --env-file .env.local`
// with E2E_ENABLE=true. No prod app server (port 3001) is needed — this suite
// talks to the edge function directly via authenticated supabase clients.

type CheckResponse = {
  installed: boolean;
  repo_accessible: boolean;
  org: string;
  install_url: string;
};

test.describe.configure({ mode: "serial" });

test.describe("github-check-app-installation edge function", () => {
  test.describe.configure({ timeout: 120_000 });

  const RUN_PREFIX = getTestRunPrefix();
  const SAFE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let classAId: number;
  let classBId: number;
  let instructorA: TestingUser;
  let studentA: TestingUser;
  let studentB: TestingUser; // enrolled in a different class

  test.beforeAll(async () => {
    const clsA = await createClass({ name: `E2E AppCheck A ${RUN_PREFIX}` });
    classAId = clsA.id;
    const clsB = await createClass({ name: `E2E AppCheck B ${RUN_PREFIX}` });
    classBId = clsB.id;

    instructorA = await createUserInClass({
      role: "instructor",
      class_id: classAId,
      name: `AppCheck Instructor ${RUN_PREFIX}`,
      email: `e2e-appcheck-instr-${SAFE_ID}@pawtograder.net`
    });
    studentA = await createUserInClass({
      role: "student",
      class_id: classAId,
      name: `AppCheck Student ${RUN_PREFIX}`,
      email: `e2e-appcheck-stu-${SAFE_ID}@pawtograder.net`
    });
    studentB = await createUserInClass({
      role: "student",
      class_id: classBId,
      name: `AppCheck Other ${RUN_PREFIX}`,
      email: `e2e-appcheck-other-${SAFE_ID}@pawtograder.net`
    });

    // A PR-mode assignment in class A — not strictly required by the function
    // (the check is per-repo, not per-assignment) but keeps the fixture faithful
    // to how the form invokes it.
    await insertAssignment({
      class_id: classAId,
      due_date: addDays(new Date(), 7).toISOString(),
      release_date: addDays(new Date(), -1).toUTCString(),
      name: `AppCheck assignment ${RUN_PREFIX}`,
      assignment_slug: `e2e-appcheck-${SAFE_ID}`
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization (deterministic — no GitHub call reached)
  // ---------------------------------------------------------------------------
  test("rejects a non-instructor (student) caller before touching GitHub", async () => {
    const studentClient = await createAuthenticatedClient(studentA);
    const { data, error } = await studentClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo: "some-org/some-repo", class_id: classAId }
    });
    // The handler throws SecurityError("Unauthorized") -> 401 -> the SDK surfaces
    // an error and returns no body to the unauthorized caller.
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
    // Confirm it's the authz rejection (401), not a transient GitHub failure.
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(401);
    }
  });

  test("rejects a caller who is an instructor in a DIFFERENT class", async () => {
    // instructorA is an instructor in class A but has no role in class B, so a
    // check scoped to class B must be rejected (the role lookup is class-scoped).
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { data, error } = await instructorClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo: "some-org/some-repo", class_id: classBId }
    });
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(401);
    }
  });

  test("rejects a student enrolled in another class entirely", async () => {
    const studentClient = await createAuthenticatedClient(studentB);
    const { data, error } = await studentClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo: "some-org/some-repo", class_id: classAId }
    });
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Input validation (deterministic — UserVisibleError 400, no GitHub call)
  // ---------------------------------------------------------------------------
  test("rejects a repo not in owner/name form with a 400", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { error } = await instructorClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo: "no-slash-here", class_id: classAId }
    });
    expect(error).not.toBeNull();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(400);
      const body = await error.context.json().catch(() => null);
      // UserVisibleError surfaces its message; the handler complains about the
      // "owner/name" form.
      expect(JSON.stringify(body ?? {})).toMatch(/owner\/name/i);
    }
  });

  test("rejects a missing class_id with a 400", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const { error } = await instructorClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      // class_id omitted -> handler throws UserVisibleError("class_id is required")
      body: { repo: "some-org/some-repo" }
    });
    expect(error).not.toBeNull();
    if (error?.context instanceof Response) {
      expect(error.context.status).toBe(400);
    }
  });

  // ---------------------------------------------------------------------------
  // Instructor + valid repo: response SHAPE (the GitHub-dependent fields are not
  // deterministic locally — see file header). We assert the documented contract
  // only when a 200 body is returned, and otherwise tolerate the dummy-credential
  // GitHub failure rather than writing a flaky assertion.
  // ---------------------------------------------------------------------------
  test("instructor caller: response has the documented shape OR errors on the GitHub call (local-cred limitation)", async () => {
    const instructorClient = await createAuthenticatedClient(instructorA);
    const repo = `some-org-${SAFE_ID}/some-repo`;
    const { data, error } = await instructorClient.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo, class_id: classAId }
    });

    if (error) {
      // EXPECTED on the local stack: getOctoKit() calls the real GitHub API with
      // dummy app credentials; that throws and the handler returns 500. We assert
      // it is NOT an authz/validation rejection (those are covered above) — i.e.
      // the request got PAST authz and validation to the GitHub call.
      if (error.context instanceof Response) {
        expect([500, 502, 503, 504]).toContain(error.context.status);
      }
      return;
    }

    // If the environment can resolve installations (e.g. CI with real-ish app
    // creds), the body must match the documented contract.
    expect(data).not.toBeNull();
    expect(typeof data!.installed).toBe("boolean");
    expect(typeof data!.repo_accessible).toBe("boolean");
    expect(data!.org).toBe(repo.split("/")[0]);
    // install_url is always present and is a GitHub URL: either the slug-aware
    // deep link (apps/<slug>/installations/new/permissions?target_id=...) when a
    // GITHUB_APP_SLUG is known, or the generic settings/installations fallback.
    expect(typeof data!.install_url).toBe("string");
    expect(data!.install_url).toMatch(/^https:\/\/github\.com\//);
    expect(
      /\/apps\/[^/]+\/installations\/new/.test(data!.install_url) ||
        data!.install_url === "https://github.com/settings/installations"
    ).toBe(true);
    // If installed is false, repo_accessible cannot be true (you can't access a
    // repo through an installation that doesn't exist).
    if (!data!.installed) {
      expect(data!.repo_accessible).toBe(false);
    }
  });

  test("service role is not an instructor either: the function is authz-gated, not key-gated", async () => {
    // Sanity: the service-role client carries no user identity for the authz
    // lookup, so even it is rejected (the function reads the caller's user via
    // the Authorization bearer + user_roles, not the key's privileges).
    const { data, error } = await supabase.functions.invoke<CheckResponse>("github-check-app-installation", {
      body: { repo: "some-org/some-repo", class_id: classAId }
    });
    expect(error).not.toBeNull();
    expect(data?.installed).toBeUndefined();
  });
});
