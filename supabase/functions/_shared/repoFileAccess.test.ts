/**
 * The host and org checks in front of repository-get-file, -list-files and -write-file (#1385).
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/repoFileAccess.test.ts
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { UserVisibleError } from "./HandlerUtils.ts";

// repoFileAccess imports GitProvider, whose GitHubWrapper builds a GitHub App at import time and needs a private key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { assertForgejoCourseOrg, assertGitHubCourseRepo, forgejoOrgForClass, parseGitProvider, repoFilesFor } =
  await import("./repoFileAccess.ts");

Deno.test("parseGitProvider: omitted means GitHub, and anything but the two hosts is refused", () => {
  assertEquals(parseGitProvider(undefined), "github");
  assertEquals(parseGitProvider(null), "github");
  assertEquals(parseGitProvider("github"), "github");
  assertEquals(parseGitProvider("forgejo"), "forgejo");
  assertThrows(() => parseGitProvider("gitlab"), UserVisibleError, "gitProvider must be github or forgejo");
});

Deno.test("forgejoOrgForClass: forgejo_org, else the slug, lowercased", () => {
  assertEquals(forgejoOrgForClass({ slug: "CS4535", forgejo_org: null }), "cs4535");
  assertEquals(forgejoOrgForClass({ slug: "cs4535", forgejo_org: "  " }), "cs4535");
  assertEquals(forgejoOrgForClass({ slug: "cs4535-sec2", forgejo_org: "Shared" }), "shared");
  assertEquals(forgejoOrgForClass({ slug: null, forgejo_org: null }), null);
});

function classClient(row: { slug: string | null; forgejo_org: string | null } | null, error: unknown = null) {
  const query = {
    select: () => query,
    eq: () => query,
    single: () => Promise.resolve({ data: row, error })
  };
  return { from: () => query } as unknown as Parameters<typeof assertForgejoCourseOrg>[0];
}

Deno.test("assertForgejoCourseOrg: the class's own org passes, case-insensitively", async () => {
  await assertForgejoCourseOrg(classClient({ slug: "cs4535", forgejo_org: null }), 1, "CS4535");
  await assertForgejoCourseOrg(classClient({ slug: "cs4535", forgejo_org: "shared" }), 1, "shared");
});

Deno.test("assertForgejoCourseOrg: another org is a 403, even the class's slug once forgejo_org is set", async () => {
  const refused = await assertRejects(
    () => assertForgejoCourseOrg(classClient({ slug: "cs4535", forgejo_org: "shared" }), 1, "cs4535"),
    UserVisibleError
  );
  assertEquals(refused.status, 403);
  await assertRejects(
    () => assertForgejoCourseOrg(classClient({ slug: "cs4535", forgejo_org: null }), 1, "cs3500"),
    UserVisibleError,
    "course's Forgejo org is cs4535"
  );
});

Deno.test("assertForgejoCourseOrg: a failed class lookup is a 500, not a refusal", async () => {
  const error = await assertRejects(
    () => assertForgejoCourseOrg(classClient(null, { message: "timeout" }), 1, "cs4535"),
    UserVisibleError
  );
  assertEquals(error.status, 500);
});

/** Course 1 has no GitHub org unless given one; course 2 is another course with its own grader. */
function githubCourseClient(githubOrg: string | null, instructorOf: number[] = []) {
  const assignments = [
    { class_id: 1, autograder: { grader_repo: "pawtograder-playground/test-e2e-java-solution" } },
    { class_id: 1, autograder: null },
    // Saved by course 1's instructor, but neu-cs3500 is course 2's org.
    { class_id: 1, autograder: { grader_repo: "neu-cs3500/hw1-private" } },
    { class_id: 2, autograder: { grader_repo: "other-org/cs3500-hw1-solution" } }
  ];
  return {
    rpc: (_fn: string, args: { class__id: number }) =>
      Promise.resolve({ data: instructorOf.includes(args.class__id), error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return query;
        },
        single: () => Promise.resolve({ data: { github_org: githubOrg }, error: null }),
        then: (resolve: (result: unknown) => void) => {
          if (table !== "assignments") throw new Error(`unexpected list query on ${table}`);
          resolve({ data: assignments.filter((a) => a.class_id === filters.class_id), error: null });
        }
      };
      return query;
    }
  } as unknown as Parameters<typeof assertGitHubCourseRepo>[0];
}

/** The service-role view of classes: course 2 owns neu-cs3500. */
function otherCoursesClient() {
  const classes = [
    { id: 1, github_org: null },
    { id: 2, github_org: "neu-cs3500" }
  ];
  return () =>
    ({
      from: () => {
        let rows = classes;
        const query = {
          select: () => query,
          ilike: (_column: string, pattern: string) => {
            rows = rows.filter((c) => c.github_org?.toLowerCase() === pattern.toLowerCase());
            return query;
          },
          neq: (_column: string, id: number) => {
            rows = rows.filter((c) => c.id !== id);
            return query;
          },
          limit: () => Promise.resolve({ data: rows, error: null })
        };
        return query;
      }
    }) as unknown as ReturnType<NonNullable<Parameters<typeof assertGitHubCourseRepo>[5]>>;
}

Deno.test("assertGitHubCourseRepo: a repo in the course's org passes, case-insensitively", async () => {
  await assertGitHubCourseRepo(githubCourseClient("neu-cs4535"), 1, "NEU-CS4535", "hw1", {
    write: true
  });
});

Deno.test("assertGitHubCourseRepo: with no org, the course's own grader repo passes, case-insensitively", async () => {
  await assertGitHubCourseRepo(
    githubCourseClient(null),
    1,
    "Pawtograder-Playground",
    "Test-E2E-Java-Solution",
    { write: false },
    otherCoursesClient()
  );
});

Deno.test("assertGitHubCourseRepo: the course's own grader repo outside its org can't be written", async () => {
  const refused = await assertRejects(
    () =>
      assertGitHubCourseRepo(
        githubCourseClient(null),
        1,
        "pawtograder-playground",
        "test-e2e-java-solution",
        { write: true },
        otherCoursesClient()
      ),
    UserVisibleError,
    "can be written"
  );
  assertEquals(refused.status, 403);
});

Deno.test(
  "assertGitHubCourseRepo: a grader in another course's org passes for an instructor of that course",
  async () => {
    await assertGitHubCourseRepo(
      githubCourseClient(null, [2]),
      1,
      "neu-cs3500",
      "hw1-private",
      { write: false },
      otherCoursesClient()
    );
  }
);

Deno.test("assertGitHubCourseRepo: a grader saved in another course's org is a 403", async () => {
  const refused = await assertRejects(
    () =>
      assertGitHubCourseRepo(
        githubCourseClient(null),
        1,
        "NEU-CS3500",
        "hw1-private",
        { write: false },
        otherCoursesClient()
      ),
    UserVisibleError,
    "another course's GitHub org"
  );
  assertEquals(refused.status, 403);
});

Deno.test("assertGitHubCourseRepo: with no org, another course's grader repo is a 403", async () => {
  const refused = await assertRejects(
    () =>
      assertGitHubCourseRepo(githubCourseClient(null), 1, "other-org", "cs3500-hw1-solution", {
        write: false
      }),
    UserVisibleError
  );
  assertEquals(refused.status, 403);
});

Deno.test("assertGitHubCourseRepo: a random repo is a 403, even next to the course's grader", async () => {
  for (const [org, repo] of [
    ["someone-else", "secrets"],
    ["pawtograder-playground", "another-solution"]
  ]) {
    const refused = await assertRejects(
      () => assertGitHubCourseRepo(githubCourseClient("neu-cs4535"), 1, org, repo, { write: false }),
      UserVisibleError
    );
    assertEquals(refused.status, 403);
  }
});

Deno.test("assertGitHubCourseRepo: the pawtograder org passes only when the caller allows it", async () => {
  await assertGitHubCourseRepo(githubCourseClient(null), 1, "pawtograder", "template", { write: false });
  await assertRejects(
    () => assertGitHubCourseRepo(githubCourseClient(null), 1, "pawtograder", "template", { write: true }),
    UserVisibleError,
    "only repos in the course's GitHub org (not set) can be written"
  );
});

Deno.test("repoFilesFor: Forgejo without its settings is a 503", () => {
  const saved = Deno.env.get("FORGEJO_URL");
  Deno.env.delete("FORGEJO_URL");
  try {
    const error = assertThrows(() => repoFilesFor("forgejo"), UserVisibleError);
    assertEquals(error.status, 503);
  } finally {
    if (saved !== undefined) Deno.env.set("FORGEJO_URL", saved);
  }
});
