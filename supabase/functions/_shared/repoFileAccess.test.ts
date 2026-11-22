/**
 * The host and org checks in front of repository-get-file, -list-files and -write-file (#1385).
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/repoFileAccess.test.ts
 */
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { UserVisibleError } from "./HandlerUtils.ts";

// repoFileAccess imports GitProvider, whose GitHubWrapper builds a GitHub App at import time and needs a private key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { assertForgejoCourseOrg, forgejoOrgForClass, parseGitProvider, repoFilesFor } = await import(
  "./repoFileAccess.ts"
);

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
