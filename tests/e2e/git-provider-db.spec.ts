import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/utils/supabase/SupabaseTypes";
import { createClass, createUserInClass, getAuthTokenForUser, setCourseFeature, supabase } from "./TestingUtils";

// Database/API coverage only. No Forgejo instance or real GitHub calls are needed.
async function ok<T>(query: PromiseLike<{ data: T; error: unknown }>) {
  const result = await query;
  expect(result.error).toBeNull();
  return result.data!;
}
async function createAssignment(classId: number, provider?: string) {
  const settings = await ok(
    supabase.from("assignment_self_review_settings").insert({ class_id: classId, enabled: false }).select("id").single()
  );
  return supabase
    .from("assignments")
    .insert({
      class_id: classId,
      title: "Provider test",
      slug: `provider-${crypto.randomUUID()}`,
      due_date: new Date(Date.now() + 30 * 86400_000).toISOString(),
      release_date: new Date(Date.now() + 86400_000).toISOString(),
      group_config: "individual",
      self_review_setting_id: settings.id,
      has_autograder: false,
      ...(provider === undefined ? {} : { git_provider: provider })
    })
    .select("*")
    .single();
}
async function fixture(provider: "github" | "forgejo") {
  const course = await createClass({ name: "Provider boundaries" });
  await setCourseFeature(course.id, "cloud-workspaces", true);
  return { course, assignment: await ok(createAssignment(course.id, provider)) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function repository(f: Fixture, extra: Partial<Database["public"]["Tables"]["repositories"]["Insert"]> = {}) {
  return supabase
    .from("repositories")
    .insert({
      class_id: f.course.id,
      assignment_id: f.assignment.id,
      repository: `e2e-ignore/repo-${crypto.randomUUID()}`,
      ...extra
    })
    .select("*")
    .single();
}
const reposFor = (id: number) => supabase.from("repositories").select("id").eq("assignment_id", id);
const switchHost = (id: number, git_provider: string) =>
  supabase.from("assignments").update({ git_provider }).eq("id", id);

test("existing callers default assignments and repositories to GitHub", async () => {
  const course = await createClass({ name: "Provider defaults" });
  expect(course.forgejo_org).toBeNull();
  const assignment = await ok(createAssignment(course.id));
  expect(assignment.git_provider).toBe("github");
  expect((await ok(repository({ course, assignment }))).git_provider).toBe("github");
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
    await ok(supabase.from("classes").update({ features }).eq("id", course.id));
    const result = await createAssignment(course.id, "forgejo");
    expect(result.error?.code).toBe("23514");
    expect(result.error?.message).toContain("cloud-workspaces");
  });
}
test("the host can change before provisioning, but not after a repository exists", async () => {
  const f = await fixture("github");
  for (const provider of ["forgejo", "github"]) await ok(switchHost(f.assignment.id, provider));
  await ok(repository(f));
  const result = await switchHost(f.assignment.id, "forgejo");
  expect(result.error?.code).toBe("23514");
  expect(result.error?.message).toContain("after repositories exist");
});
test("a repository must match its assignment on insert and update", async () => {
  const f = await fixture("forgejo");
  expect((await repository(f)).error?.code).toBe("23514");
  const repo = await ok(repository(f, { git_provider: "forgejo" }));
  const changed = await supabase.from("repositories").update({ git_provider: "github" }).eq("id", repo.id);
  expect(changed.error?.code).toBe("23514");
});
test("disabling the flag blocks new selections without rewriting existing assignments", async () => {
  const { course, assignment } = await fixture("forgejo");
  await setCourseFeature(course.id, "cloud-workspaces", false);
  const unchanged = await ok(
    supabase
      .from("assignments")
      .update({ title: "Still on Forgejo", git_provider: "forgejo" })
      .eq("id", assignment.id)
      .select("git_provider")
      .single()
  );
  expect(unchanged.git_provider).toBe("forgejo");
  expect((await createAssignment(course.id, "forgejo")).error?.code).toBe("23514");
});
for (const provider of ["github", "forgejo"] as const) {
  for (const qualified of [false, true]) {
    test(`${provider} queues respect ${qualified ? "owner/name" : "short"} names`, async () => {
      const f = await fixture(provider);
      const repoName = `e2e-ignore-${crypto.randomUUID()}`;
      const common = { p_class_id: f.course.id, p_org: "e2e-ignore", p_debug_id: `cw10-${crypto.randomUUID()}` };
      const creation = await ok(
        supabase.rpc("enqueue_github_create_repo", {
          ...common,
          p_repo_name: repoName,
          p_template_repo: "e2e-ignore/template",
          p_course_slug: f.course.slug!,
          p_github_usernames: [],
          p_assignment_id: f.assignment.id
        })
      );
      if (provider === "forgejo") {
        expect(await ok(reposFor(f.assignment.id))).toHaveLength(0);
        await ok(repository(f, { repository: `${common.p_org}/${repoName}`, git_provider: provider }));
      }
      // Group callers pass the stored full name with a different class GitHub org.
      const target = {
        ...common,
        p_org: qualified ? "different-class-org" : common.p_org,
        p_repo: qualified ? `${common.p_org}/${repoName}` : repoName
      };
      const sync = await ok(
        supabase.rpc("enqueue_github_sync_repo_permissions", {
          ...target,
          p_course_slug: f.course.slug!,
          p_github_usernames: []
        })
      );
      const archive = await ok(supabase.rpc("enqueue_github_archive_repo", target));
      for (const value of [creation, sync, archive]) {
        if (provider === "github") expect(value).toBeGreaterThan(0);
        else expect(value).toBeNull();
      }
      const calls = await ok(supabase.from("api_gateway_calls").select("method").eq("debug_id", common.p_debug_id));
      expect(calls.map((c) => c.method).sort()).toEqual(
        provider === "github" ? ["archive_repo_and_lock", "create_repo", "sync_repo_permissions"] : []
      );
    });
  }
  for (const direct of [false, true]) {
    test(`${provider} ${direct ? "repository" : "assignment"} deletion preserves provider boundaries`, async () => {
      const f = await fixture(provider);
      const repo = await ok(repository(f, { git_provider: provider }));
      const result = direct
        ? await supabase.from("repositories").delete().eq("id", repo.id)
        : await supabase.rpc("delete_assignment_with_all_data", {
            p_assignment_id: f.assignment.id,
            p_class_id: f.course.id,
            p_enqueue_github_archives: true
          });
      if (provider === "github") expect(result.error).toBeNull();
      else expect(result.error?.code).toBe("0A000");
      expect(await ok(reposFor(f.assignment.id))).toHaveLength(provider === "github" ? 0 : 1);
    });
  }
  test(`${provider} fork sources stay provider-consistent`, async () => {
    const { course, assignment: source } = await fixture(provider);
    const target = await ok(createAssignment(course.id, provider));
    const other = provider === "github" ? "forgejo" : "github";
    const fork = { repo_mode: "fork_from_prior_assignment", source_assignment_id: source.id } as const;
    await ok(supabase.from("assignments").update(fork).eq("id", target.id));
    for (const id of [source.id, target.id]) {
      const result = await switchHost(id, other);
      expect(result.error?.code).toBe("23514");
      expect(result.error?.message).toContain("same repository host");
    }
    const incompatible = await ok(createAssignment(course.id, other));
    expect((await supabase.from("assignments").update(fork).eq("id", incompatible.id)).error?.code).toBe("23514");
  });
}
test("GitHub retries and reconciliation leave a Forgejo repository untouched", async () => {
  const f = await fixture("forgejo");
  const repo = await ok(
    repository(f, {
      git_provider: "forgejo",
      creation_attempts: 8,
      updated_at: new Date(Date.now() - 3 * 86400_000).toISOString()
    })
  );
  expect(await ok(supabase.rpc("enqueue_create_repo_for_repository", { p_repository_id: repo.id }))).toBeNull();
  await ok(supabase.rpc("reconcile_stuck_repo_creations"));
  expect(await ok(supabase.from("repositories").select("*").eq("id", repo.id).single())).toEqual(repo);
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
test("course deletion explains the restriction and preserves the course", async () => {
  const { course, assignment } = await fixture("forgejo");
  // Remove rubrics so their restrictive FK does not mask the assignment cascade.
  await ok(
    supabase
      .from("assignments")
      .update({ grading_rubric_id: null, self_review_rubric_id: null, meta_grading_rubric_id: null })
      .eq("id", assignment.id)
  );
  await ok(supabase.from("rubrics").delete().eq("class_id", course.id));
  const result = await supabase.from("classes").delete().eq("id", course.id);
  expect(result.error?.code).toBe("0A000");
  expect(result.error?.message).toContain("Deleting Forgejo assignments or their course");
  expect(result.error?.message).toContain("If no repositories exist, switch the assignment to GitHub");
  expect(await ok(supabase.from("assignments").select("id").eq("id", assignment.id))).toHaveLength(1);
  expect(await ok(supabase.from("classes").select("id").eq("id", course.id))).toHaveLength(1);
  await ok(switchHost(assignment.id, "github"));
  await ok(
    supabase.rpc("delete_assignment_with_all_data", {
      p_assignment_id: assignment.id,
      p_class_id: course.id,
      p_enqueue_github_archives: true
    })
  );
  expect(await ok(supabase.from("assignments").select("id").eq("id", assignment.id))).toHaveLength(0);
});
for (const endpoint of [
  "assignment-create-all-repos",
  "assignment-create-handout-repo",
  "assignment-create-solution-repo"
]) {
  test(`${endpoint} cannot provision a Forgejo assignment`, async () => {
    const { course, assignment } = await fixture("forgejo");
    const instructor = await createUserInClass({ class_id: course.id, role: "instructor" });
    await ok(
      supabase
        .from("assignments")
        .update({ release_date: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", assignment.id)
    );
    const { error } = await supabase.functions.invoke(endpoint, {
      headers: { Authorization: `Bearer ${await getAuthTokenForUser(instructor)}` },
      body: { courseId: course.id, assignmentId: assignment.id, class_id: course.id, assignment_id: assignment.id }
    });
    expect(error?.context.status).toBe(400);
    expect(await error.context.text()).toContain("This assignment uses Forgejo");
    expect(await ok(reposFor(assignment.id))).toHaveLength(0);
  });
}
