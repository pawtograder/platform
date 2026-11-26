/**
 * resolvePusherStanding for both hosts: a GitHub pusher is a `users.github_username`, a Forgejo
 * pusher a `git_accounts` login on the instance. The submission flow itself is exercised by
 * tests/e2e/push-no-autograder.test.tsx (GitHub) and forgejo-repo-webhook/webhook.test.ts (the
 * Forgejo handler around it).
 *
 * Run from supabase/functions:  deno test --no-check --allow-read --allow-env --allow-net _shared/PushDirectSubmission.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { fakeSupabase, repositoryRow } from "./RepoPushFakeClient.ts";

// PushDirectSubmission imports GitHubWrapper, which builds a GitHub App at import time and needs a non-empty key.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { resolvePusherStanding } = await import("./PushDirectSubmission.ts");

const FORGEJO_URL = "https://git.example.edu";

function tables(): Record<string, Record<string, unknown>[]> {
  return {
    users: [{ user_id: "u-ta", github_username: "ta-jordan" }],
    git_accounts: [
      { user_id: "u-ta", provider: "forgejo", instance_url: FORGEJO_URL, login: "ta_jordan" },
      { user_id: "u-other", provider: "forgejo", instance_url: "https://git.other.edu", login: "ta-sam" }
    ],
    user_roles: [{ user_id: "u-ta", class_id: 10, disabled: false, role: "grader", private_profile_id: "ta-profile" }]
  };
}

const studentRepo = repositoryRow({ git_provider: "forgejo", profile_id: "student-profile" });

Deno.test("resolvePusherStanding: a Forgejo login on this instance resolves to its user, ignoring case", async () => {
  const { client } = fakeSupabase(tables());
  assertEquals(await resolvePusherStanding(client, studentRepo, "TA_Jordan", new Sentry.Scope(), FORGEJO_URL), {
    isForeignStaff: true,
    isOwnerStaff: false
  });
});

Deno.test("resolvePusherStanding: a Forgejo login matches literally, so `_` is not a wildcard", async () => {
  // The only staff account here is ta-jordan. Queried unescaped, ta_jordan would match it through
  // the `_` wildcard and read as foreign staff.
  const { client } = fakeSupabase({
    ...tables(),
    git_accounts: [{ user_id: "u-ta", provider: "forgejo", instance_url: FORGEJO_URL, login: "ta-jordan" }]
  });
  const scope = new Sentry.Scope();
  assertEquals(await resolvePusherStanding(client, studentRepo, "ta_jordan", scope, FORGEJO_URL), {
    isForeignStaff: false,
    isOwnerStaff: false
  });
  assertEquals(scope.getScopeData().tags.pusher_role, "unknown_forgejo_login");
});

Deno.test("resolvePusherStanding: a Forgejo login matches only on this instance", async () => {
  // ta-sam is active staff in this class, but their account is on another instance. Matched
  // across instances, the push would read as foreign staff.
  const fixture = tables();
  fixture.user_roles.push({
    user_id: "u-other",
    class_id: 10,
    disabled: false,
    role: "grader",
    private_profile_id: "other-profile"
  });
  const { client } = fakeSupabase(fixture);
  const scope = new Sentry.Scope();
  assertEquals(await resolvePusherStanding(client, studentRepo, "ta-sam", scope, FORGEJO_URL), {
    isForeignStaff: false,
    isOwnerStaff: false
  });
  assertEquals(scope.getScopeData().tags.pusher_role, "unknown_forgejo_login");
});

Deno.test("resolvePusherStanding: without an instance the pusher is a GitHub username, as before", async () => {
  const { client, queries } = fakeSupabase(tables());
  assertEquals(await resolvePusherStanding(client, studentRepo, "ta-jordan", new Sentry.Scope()), {
    isForeignStaff: true,
    isOwnerStaff: false
  });
  assertEquals(queries[0].table, "users");
});

Deno.test("resolvePusherStanding: staff pushing to their own repository are its owner", async () => {
  const { client } = fakeSupabase(tables());
  const own = repositoryRow({ git_provider: "forgejo", profile_id: "ta-profile" });
  assertEquals(await resolvePusherStanding(client, own, "ta_jordan", new Sentry.Scope(), FORGEJO_URL), {
    isForeignStaff: false,
    isOwnerStaff: true
  });
});
