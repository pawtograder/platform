import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/utils/supabase/SupabaseTypes";
import { createClass, createUserInClass, getAuthTokenForUser, setCourseFeature, supabase } from "./TestingUtils";

// Database/API coverage only. No Forgejo instance or real GitHub calls are needed.
async function createAssignment(classId: number, provider?: string) {
  const { data: settings, error: settingsError } = await supabase
    .from("assignment_self_review_settings")
    .insert({ class_id: classId, enabled: false })
    .select("id")
    .single();
  expect(settingsError).toBeNull();
  return supabase
    .from("assignments")
    .insert({
      class_id: classId,
      title: "Provider test",
      slug: `provider-${crypto.randomUUID()}`,
      due_date: new Date(Date.now() + 30 * 86400_000).toISOString(),
      release_date: new Date(Date.now() + 86400_000).toISOString(),
      group_config: "individual",
      self_review_setting_id: settings!.id,
      has_autograder: false,
      ...(provider === undefined ? {} : { git_provider: provider })
    })
    .select("*")
    .single();
}

async function fixture(provider: "github" | "forgejo") {
  const course = await createClass({ name: "Provider boundaries" });
  await setCourseFeature(course.id, "cloud-workspaces", true);
  const { data: assignment, error } = await createAssignment(course.id, provider);
  expect(error).toBeNull();
  return { course, assignment: assignment! };
}

test("existing insert callers still default assignments and repositories to GitHub", async () => {
  const course = await createClass({ name: "Provider defaults" });
  expect(course.forgejo_org).toBeNull();
  const { data: assignment, error } = await createAssignment(course.id);
  expect(error).toBeNull();
  expect(assignment!.git_provider).toBe("github");
  const { data: repo, error: repoError } = await supabase
    .from("repositories")
    .insert({
      class_id: course.id,
      assignment_id: assignment!.id,
      repository: `e2e-ignore/default-${crypto.randomUUID()}`
    })
    .select("git_provider")
    .single();
  expect(repoError).toBeNull();
  expect(repo!.git_provider).toBe("github");
});

const disabledFlags: [string, Json | null][] = [
  ["missing", null],
  ["empty", []],
  ["non-array", { name: "cloud-workspaces", enabled: true }],
  ["disabled", [{ name: "cloud-workspaces", enabled: false }]],
  ["string boolean", [{ name: "cloud-workspaces", enabled: "true" }]],
  [
    "first entry disabled",
    [
      { name: "cloud-workspaces", enabled: false },
      { name: "cloud-workspaces", enabled: true }
    ]
  ]
];

for (const [name, features] of disabledFlags) {
  test(`Forgejo selection rejects ${name} course flags`, async () => {
    const course = await createClass({ name: "Provider opt in" });
    const { error } = await supabase.from("classes").update({ features }).eq("id", course.id);
    expect(error).toBeNull();
    const result = await createAssignment(course.id, "forgejo");
    expect(result.error?.code).toBe("23514");
    expect(result.error?.message).toContain("cloud-workspaces");
  });
}

test("the host can change before provisioning, but not after a repository exists", async () => {
  const { course, assignment } = await fixture("github");
  for (const git_provider of ["forgejo", "github"]) {
    const { error } = await supabase.from("assignments").update({ git_provider }).eq("id", assignment.id);
    expect(error).toBeNull();
  }
  const { error: insertError } = await supabase.from("repositories").insert({
    class_id: course.id,
    assignment_id: assignment.id,
    repository: `e2e-ignore/locked-${crypto.randomUUID()}`
  });
  expect(insertError).toBeNull();
  const { error } = await supabase.from("assignments").update({ git_provider: "forgejo" }).eq("id", assignment.id);
  expect(error?.code).toBe("23514");
  expect(error?.message).toContain("after repositories exist");
});

test("a repository must match its assignment on insert and update", async () => {
  const { course, assignment } = await fixture("forgejo");
  const row = {
    class_id: course.id,
    assignment_id: assignment.id,
    repository: `e2e-ignore/match-${crypto.randomUUID()}`
  };
  // An old caller omitting the provider must not mislabel a Forgejo repository as GitHub.
  const bad = await supabase.from("repositories").insert(row);
  expect(bad.error?.code).toBe("23514");
  const good = await supabase
    .from("repositories")
    .insert({ ...row, git_provider: "forgejo" })
    .select("id")
    .single();
  expect(good.error).toBeNull();
  const changed = await supabase.from("repositories").update({ git_provider: "github" }).eq("id", good.data!.id);
  expect(changed.error?.code).toBe("23514");
});

test("disabling the flag blocks new Forgejo selections without rewriting existing assignments", async () => {
  const { course, assignment } = await fixture("forgejo");
  await setCourseFeature(course.id, "cloud-workspaces", false);
  const unchanged = await supabase
    .from("assignments")
    .update({ title: "Still on Forgejo", git_provider: "forgejo" })
    .eq("id", assignment.id)
    .select("git_provider")
    .single();
  expect(unchanged.error).toBeNull();
  expect(unchanged.data!.git_provider).toBe("forgejo");
  const next = await createAssignment(course.id, "forgejo");
  expect(next.error?.code).toBe("23514");
});

for (const provider of ["github", "forgejo"] as const) {
  test(`${provider} create, permission-sync, and archive queues respect the provider`, async () => {
    const { course, assignment } = await fixture(provider);
    const repoName = `e2e-ignore-${crypto.randomUUID()}`;
    const debugId = `cw10-${crypto.randomUUID()}`;
    const common = { p_class_id: course.id, p_org: "e2e-ignore", p_debug_id: debugId };
    const creation = await supabase.rpc("enqueue_github_create_repo", {
      ...common,
      p_repo_name: repoName,
      p_template_repo: "e2e-ignore/template",
      p_course_slug: course.slug!,
      p_github_usernames: [],
      p_assignment_id: assignment.id
    });
    expect(creation.error).toBeNull();
    if (provider === "github") {
      expect(creation.data).toBeGreaterThan(0);
    } else {
      expect(creation.data).toBeNull();
      const { data: before, error: beforeError } = await supabase
        .from("repositories")
        .select("id")
        .eq("assignment_id", assignment.id);
      expect(beforeError).toBeNull();
      expect(before).toHaveLength(0);
      // Model the row a future Forgejo provisioner creates.
      const inserted = await supabase.from("repositories").insert({
        class_id: course.id,
        assignment_id: assignment.id,
        repository: `${common.p_org}/${repoName}`,
        git_provider: "forgejo"
      });
      expect(inserted.error).toBeNull();
    }
    const sync = await supabase.rpc("enqueue_github_sync_repo_permissions", {
      ...common,
      p_repo: repoName,
      p_course_slug: course.slug!,
      p_github_usernames: []
    });
    const archive = await supabase.rpc("enqueue_github_archive_repo", { ...common, p_repo: repoName });
    for (const result of [sync, archive]) {
      expect(result.error).toBeNull();
      if (provider === "github") expect(result.data).toBeGreaterThan(0);
      else expect(result.data).toBeNull();
    }
    const calls = await supabase.from("api_gateway_calls").select("method").eq("debug_id", debugId);
    expect(calls.error).toBeNull();
    expect(calls.data!.map((c) => c.method).sort()).toEqual(
      provider === "github" ? ["archive_repo_and_lock", "create_repo", "sync_repo_permissions"] : []
    );
  });
}

test("GitHub retries and reconciliation leave a Forgejo repository untouched", async () => {
  const { course, assignment } = await fixture("forgejo");
  const { data: repo, error } = await supabase
    .from("repositories")
    .insert({
      class_id: course.id,
      assignment_id: assignment.id,
      repository: `e2e-ignore/retry-${crypto.randomUUID()}`,
      git_provider: "forgejo",
      creation_attempts: 8,
      updated_at: new Date(Date.now() - 3 * 86400_000).toISOString()
    })
    .select("id, creation_attempts, creation_error, updated_at, last_creation_attempt_at")
    .single();
  expect(error).toBeNull();
  const retry = await supabase.rpc("enqueue_create_repo_for_repository", { p_repository_id: repo!.id });
  expect(retry.error).toBeNull();
  expect(retry.data).toBeNull();
  const reconcile = await supabase.rpc("reconcile_stuck_repo_creations");
  expect(reconcile.error).toBeNull();
  const after = await supabase
    .from("repositories")
    .select("id, creation_attempts, creation_error, updated_at, last_creation_attempt_at")
    .eq("id", repo!.id)
    .single();
  expect(after.error).toBeNull();
  expect(after.data).toEqual(repo);
});

test("GitHub enqueue RPCs remain inaccessible to anonymous callers", async () => {
  const anon = createClient<Database>(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const result = await anon.rpc("enqueue_github_archive_repo", {
    p_class_id: -1,
    p_org: "e2e-ignore",
    p_repo: "must-not-enqueue"
  });
  expect(result.error?.code).toBe("42501");
});

for (const provider of ["github", "forgejo"] as const) {
  test(`${provider} deletion cannot send a Forgejo name to GitHub after deleting its database row`, async () => {
    const { course, assignment } = await fixture(provider);
    const name = `e2e-ignore/delete-${crypto.randomUUID()}`;
    const inserted = await supabase.from("repositories").insert({
      class_id: course.id,
      assignment_id: assignment.id,
      repository: name,
      git_provider: provider
    });
    expect(inserted.error).toBeNull();
    const result = await supabase.rpc("delete_assignment_with_all_data", {
      p_assignment_id: assignment.id,
      p_class_id: course.id,
      p_enqueue_github_archives: true
    });
    if (provider === "github") expect(result.error).toBeNull();
    else expect(result.error?.message).toContain("Deleting Forgejo assignments or their course is not supported yet");
    const remaining = await supabase.from("repositories").select("id").eq("repository", name);
    expect(remaining.error).toBeNull();
    // Rejection rolls back the entire delete, including the repository rows removed before it.
    expect(remaining.data).toHaveLength(provider === "github" ? 0 : 1);
  });
}

test("course deletion explains the Forgejo restriction and preserves the course", async () => {
  const { course, assignment } = await fixture("forgejo");
  // Remove auto-created rubrics so their existing restrictive class FK does not mask the assignment cascade.
  const detached = await supabase
    .from("assignments")
    .update({ grading_rubric_id: null, self_review_rubric_id: null, meta_grading_rubric_id: null })
    .eq("id", assignment.id);
  expect(detached.error).toBeNull();
  const rubrics = await supabase.from("rubrics").delete().eq("class_id", course.id);
  expect(rubrics.error).toBeNull();
  const result = await supabase.from("classes").delete().eq("id", course.id);
  expect(result.error?.code).toBe("0A000");
  expect(result.error?.message).toContain("Deleting Forgejo assignments or their course");
  expect(result.error?.message).toContain("If no repositories exist, switch the assignment to GitHub");
  const remaining = await supabase.from("assignments").select("id").eq("id", assignment.id);
  expect(remaining.error).toBeNull();
  expect(remaining.data).toHaveLength(1);
  const preserved = await supabase.from("classes").select("id").eq("id", course.id);
  expect(preserved.error).toBeNull();
  expect(preserved.data).toHaveLength(1);
  // An unprovisioned demo assignment can be switched back and deleted through the normal RPC.
  const switched = await supabase.from("assignments").update({ git_provider: "github" }).eq("id", assignment.id);
  expect(switched.error).toBeNull();
  const deleted = await supabase.rpc("delete_assignment_with_all_data", {
    p_assignment_id: assignment.id,
    p_class_id: course.id,
    p_enqueue_github_archives: true
  });
  expect(deleted.error).toBeNull();
  const after = await supabase.from("assignments").select("id").eq("id", assignment.id);
  expect(after.error).toBeNull();
  expect(after.data).toHaveLength(0);
});

test("GitHub creation explains why it cannot provision a Forgejo assignment", async () => {
  const { course, assignment } = await fixture("forgejo");
  const instructor = await createUserInClass({ class_id: course.id, role: "instructor" });
  const released = await supabase
    .from("assignments")
    .update({ release_date: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", assignment.id);
  expect(released.error).toBeNull();
  const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/assignment-create-all-repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAuthTokenForUser(instructor)}`,
      apikey: (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ courseId: course.id, assignmentId: assignment.id })
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("This assignment uses Forgejo");
  const repositories = await supabase.from("repositories").select("id").eq("assignment_id", assignment.id);
  expect(repositories.error).toBeNull();
  expect(repositories.data).toHaveLength(0);
});
