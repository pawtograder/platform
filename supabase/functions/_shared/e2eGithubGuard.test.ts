/**
 * Unit tests for the e2e fixture guard predicate.
 *
 * This is the contract that decides whether a GitHub-touching edge function skips real api.github.com
 * for a fixture. The naming prefixes ARE the contract, so pin them down — especially the negative
 * cases (wrong org, real slug) that must keep hitting real GitHub in genuine integration tests.
 *
 * Run from supabase/functions:  deno test --allow-env _shared/e2eGithubGuard.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { isE2eFixtureTarget, shouldSkipRealGithubForE2eFixture } from "./e2eGithubGuard.ts";

Deno.test("isE2eFixtureTarget: wrong org never matches, even with an e2e-ignore- slug", () => {
  assertEquals(isE2eFixtureTarget({ org: "some-real-org", courseSlug: "e2e-ignore-foo" }), false);
  assertEquals(isE2eFixtureTarget({ org: null, courseSlug: "e2e-ignore-foo" }), false);
});

Deno.test("isE2eFixtureTarget: fixture org + e2e-ignore- course slug matches", () => {
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground", courseSlug: "e2e-ignore-foo" }), true);
});

Deno.test("isE2eFixtureTarget: fixture org + fixture repo name prefixes match", () => {
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground", repoName: "test-e2e-handout" }), true);
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground", repoName: "e2e-test-handout" }), true);
  // archive_repo_and_lock matches the repo name against e2e-ignore- (no courseSlug in scope)
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground", repoName: "e2e-ignore-foo-handout" }), true);
});

Deno.test("isE2eFixtureTarget: fixture org + real slug + non-fixture repo name does NOT match", () => {
  // Genuine integration tests use the fixture org with normal names; they must still hit real GitHub.
  assertEquals(
    isE2eFixtureTarget({ org: "pawtograder-playground", courseSlug: "fall-2026-cs101", repoName: "fall-2026-cs101-handout-hw1" }),
    false
  );
});

Deno.test("isE2eFixtureTarget: null/undefined identifiers do not throw and do not match", () => {
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground" }), false);
  assertEquals(isE2eFixtureTarget({ org: "pawtograder-playground", courseSlug: null, repoName: null }), false);
  assertEquals(isE2eFixtureTarget({ org: undefined }), false);
});

Deno.test("shouldSkipRealGithubForE2eFixture: stub mode always wins (returns false)", () => {
  const prev = Deno.env.get("PAWTOGRADER_GITHUB_STUB");
  try {
    Deno.env.set("PAWTOGRADER_GITHUB_STUB", "1");
    // Even a clear fixture match must not skip — the stub seam should record the call instead.
    assertEquals(shouldSkipRealGithubForE2eFixture({ org: "pawtograder-playground", courseSlug: "e2e-ignore-foo" }), false);
  } finally {
    if (prev === undefined) Deno.env.delete("PAWTOGRADER_GITHUB_STUB");
    else Deno.env.set("PAWTOGRADER_GITHUB_STUB", prev);
  }
});

Deno.test("shouldSkipRealGithubForE2eFixture: without stub, delegates to the predicate", () => {
  const prev = Deno.env.get("PAWTOGRADER_GITHUB_STUB");
  try {
    Deno.env.delete("PAWTOGRADER_GITHUB_STUB");
    assertEquals(shouldSkipRealGithubForE2eFixture({ org: "pawtograder-playground", courseSlug: "e2e-ignore-foo" }), true);
    assertEquals(shouldSkipRealGithubForE2eFixture({ org: "pawtograder-playground", courseSlug: "fall-2026" }), false);
  } finally {
    if (prev === undefined) Deno.env.delete("PAWTOGRADER_GITHUB_STUB");
    else Deno.env.set("PAWTOGRADER_GITHUB_STUB", prev);
  }
});
