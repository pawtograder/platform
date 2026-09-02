/**
 * Unit tests for the empty-repo detection helpers that make createRepo self-healing.
 *
 * These are the decision points that turn a blank student repo into either a repair
 * (delete + regenerate) or a precise, non-retryable error — so they're worth pinning down.
 * They take an Octokit as a parameter, so we drive them with a fake `request` router.
 *
 * Run from supabase/functions:  deno test --no-check --allow-env --allow-net _shared/GitHubWrapper.test.ts
 * (--no-check: this module transitively imports octokit whose bundled types trip deno's local
 *  checker; that's pre-existing and unrelated to the logic under test.)
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { Octokit, RequestError } from "npm:octokit";

// GitHubWrapper builds a GitHub App at import time, which requires a non-empty private key. The
// helpers under test never authenticate, so set a placeholder before importing the module (dynamic
// import so the env is set first — static imports would hoist above this).
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const {
  assertSourceNotEmpty,
  computeCollaboratorRemovals,
  getGitHubUserIfExists,
  getTeamAndCreateIfNeeded,
  getTeamMembers,
  isRepoEmpty,
  isTeamAlreadyExistsError,
  NonRetryableRepoError,
  publicSupabaseUrl,
  resolveExistingTeamSlug,
  TeamMembersUnreadableError,
  TeamNotFoundError,
  toPublicSupabaseUrl
} = await import("./GitHubWrapper.ts");

type Handler = (params: Record<string, unknown>) => unknown;

function fakeOctokit(handlers: Record<string, Handler>): Octokit {
  const call = async (route: string, params: Record<string, unknown>) => {
    const h = handlers[route];
    if (!h) throw new Error(`unexpected route: ${route}`);
    return await h(params);
  };
  return {
    request: call,
    // paginate returns the concatenated items; our list handlers return the array directly.
    paginate: async (route: string, params: Record<string, unknown>) => await call(route, params)
  } as unknown as Octokit;
}

function requestError(status: number, message = "error", data: unknown = {}): RequestError {
  return new RequestError(message, status, {
    request: { method: "GET", url: "https://api.github.com/x", headers: {} },
    // deno-lint-ignore no-explicit-any
    response: { status, url: "https://api.github.com/x", headers: {}, data } as any
  });
}

// GitHub's 422 for a duplicate team name: structured `code: "already_exists"` on a Team resource.
function teamAlreadyExistsError(): RequestError {
  return requestError(422, "Validation Failed", {
    errors: [{ resource: "Team", code: "already_exists", field: "name" }]
  });
}

const META_OK: Handler = () => ({ data: { default_branch: "main" } });

Deno.test("isRepoEmpty: default-branch ref resolves -> not empty", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({ data: { object: { sha: "abc" } } })
  });
  assertEquals(await isRepoEmpty(octokit, "org", "repo"), false);
});

Deno.test("isRepoEmpty: 409 Git Repository is empty -> empty", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
      throw requestError(409, "Git Repository is empty.");
    }
  });
  assertEquals(await isRepoEmpty(octokit, "org", "repo"), true);
});

Deno.test("isRepoEmpty: 404 on ref -> empty", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
      throw requestError(404, "Not Found");
    }
  });
  assertEquals(await isRepoEmpty(octokit, "org", "repo"), true);
});

Deno.test("isRepoEmpty: unexpected error (500) rethrows", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
      throw requestError(500, "Server Error");
    }
  });
  await assertRejects(() => isRepoEmpty(octokit, "org", "repo"), RequestError);
});

Deno.test("assertSourceNotEmpty: populated source resolves", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({ data: { object: { sha: "abc" } } })
  });
  // Should not throw.
  await assertSourceNotEmpty(octokit, "org", "template", "org/template");
});

Deno.test("assertSourceNotEmpty: empty source -> NonRetryableRepoError", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": META_OK,
    "GET /repos/{owner}/{repo}/git/ref/{ref}": () => {
      throw requestError(409, "Git Repository is empty.");
    }
  });
  const err = await assertRejects(
    () => assertSourceNotEmpty(octokit, "org", "template", "org/template"),
    NonRetryableRepoError
  );
  assertEquals(err.message.includes("empty"), true);
});

Deno.test("assertSourceNotEmpty: missing source (404 on repo) -> NonRetryableRepoError", async () => {
  const octokit = fakeOctokit({
    "GET /repos/{owner}/{repo}": () => {
      throw requestError(404, "Not Found");
    }
  });
  const err = await assertRejects(
    () => assertSourceNotEmpty(octokit, "org", "template", "org/template"),
    NonRetryableRepoError
  );
  assertEquals(err.message.includes("not found"), true);
});

// --- Idempotent team creation (getTeamAndCreateIfNeeded) ---

Deno.test("isTeamAlreadyExistsError: 422 already_exists -> true", () => {
  assertEquals(isTeamAlreadyExistsError(teamAlreadyExistsError()), true);
});

Deno.test("isTeamAlreadyExistsError: 422 with 'Name must be unique' message -> true", () => {
  assertEquals(isTeamAlreadyExistsError(requestError(422, "Name must be unique for this org")), true);
});

Deno.test("isTeamAlreadyExistsError: unrelated 422 / 404 / non-RequestError -> false", () => {
  assertEquals(isTeamAlreadyExistsError(requestError(422, "Some other validation error")), false);
  assertEquals(isTeamAlreadyExistsError(requestError(404, "Not Found")), false);
  assertEquals(isTeamAlreadyExistsError(new Error("already exists")), false);
});

Deno.test("getTeamAndCreateIfNeeded: team exists -> returns it without creating", async () => {
  let posted = false;
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => ({ data: { id: 7, slug: "cs101-staff" } }),
    "POST /orgs/{org}/teams": () => {
      posted = true;
      return { data: { id: 999 } };
    }
  });
  const team = await getTeamAndCreateIfNeeded("org", "cs101-staff", octokit);
  assertEquals(team.data.id, 7);
  assertEquals(posted, false);
});

Deno.test("getTeamAndCreateIfNeeded: 404 then create -> returns new team", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(404, "Not Found");
    },
    "POST /orgs/{org}/teams": () => ({ data: { id: 42, slug: "cs101-staff" } })
  });
  const team = await getTeamAndCreateIfNeeded("org", "cs101-staff", octokit);
  assertEquals(team.data.id, 42);
});

// The regression: GET 404s (race / slug mismatch) but POST then 422s because the team already
// exists. Previously this threw; now it re-fetches the existing team instead.
Deno.test("getTeamAndCreateIfNeeded: 404 then 422-already-exists -> re-fetches existing team", async () => {
  let getCalls = 0;
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      getCalls++;
      if (getCalls === 1) throw requestError(404, "Not Found");
      return { data: { id: 55, slug: "cs101-staff" } };
    },
    "POST /orgs/{org}/teams": () => {
      throw teamAlreadyExistsError();
    }
  });
  const team = await getTeamAndCreateIfNeeded("org", "cs101-staff", octokit);
  assertEquals(team.data.id, 55);
  assertEquals(getCalls, 2);
});

Deno.test("getTeamAndCreateIfNeeded: unexpected 500 on GET rethrows", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(500, "Server Error");
    }
  });
  await assertRejects(() => getTeamAndCreateIfNeeded("org", "cs101-staff", octokit), RequestError);
});

// Out-of-band team whose GitHub-normalized slug differs from the requested name: GET by the
// requested slug 404s, POST 422s, re-GET 404s, so we locate it in the org team list and return it
// under its ACTUAL slug (so callers issue subsequent member calls against the right slug).
Deno.test("getTeamAndCreateIfNeeded: 422 then slug mismatch -> resolves via org team list", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": (p) => {
      if (p.team_slug === "cs101-staff") throw requestError(404, "Not Found");
      return { data: { id: 88, slug: p.team_slug } };
    },
    "POST /orgs/{org}/teams": () => {
      throw teamAlreadyExistsError();
    },
    "GET /orgs/{org}/teams": () => [{ id: 88, slug: "cs-101-staff", name: "cs101-staff" }]
  });
  const team = await getTeamAndCreateIfNeeded("org", "cs101-staff", octokit);
  assertEquals(team.data.id, 88);
  assertEquals(team.data.slug, "cs-101-staff");
});

// A transient (non-404) failure on the post-422 re-fetch must propagate, not be masked by the
// full-team-scan fallback.
Deno.test("getTeamAndCreateIfNeeded: 422 then non-404 on re-fetch -> rethrows", async () => {
  let getCalls = 0;
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      getCalls++;
      if (getCalls === 1) throw requestError(404, "Not Found");
      throw requestError(500, "Server Error");
    },
    "POST /orgs/{org}/teams": () => {
      throw teamAlreadyExistsError();
    }
  });
  await assertRejects(() => getTeamAndCreateIfNeeded("org", "cs101-staff", octokit), RequestError);
});

// --- Non-creating slug resolution (resolveExistingTeamSlug) ---
// Uses a distinct org/slug per test since resolution is memoized per (org, requestedSlug).

Deno.test("resolveExistingTeamSlug: team exists under requested slug -> returns actual slug", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": (p) => ({ data: { id: 1, slug: p.team_slug } })
  });
  assertEquals(await resolveExistingTeamSlug("org-a", "cs101-staff", octokit), "cs101-staff");
});

Deno.test("resolveExistingTeamSlug: 404 then normalized slug in org list -> returns normalized slug", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(404, "Not Found");
    },
    "GET /orgs/{org}/teams": () => [{ id: 2, slug: "cs-101-students", name: "cs101-students" }]
  });
  assertEquals(await resolveExistingTeamSlug("org-b", "cs101-students", octokit), "cs-101-students");
});

Deno.test("resolveExistingTeamSlug: 404 and no match -> falls back to requested slug, not cached", async () => {
  // Team doesn't exist yet on the first call, then a later team-sync creates it. The no-match
  // fallback must NOT be cached, so the retry in the same isolate picks up the real slug.
  let teamExists = false;
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": (p) => {
      if (teamExists) return { data: { id: 3, slug: p.team_slug } };
      throw requestError(404, "Not Found");
    },
    "GET /orgs/{org}/teams": () => (teamExists ? [{ id: 3, slug: "cs101-staff", name: "cs101-staff" }] : [])
  });
  assertEquals(await resolveExistingTeamSlug("org-c", "cs101-staff", octokit), "cs101-staff");
  teamExists = true;
  assertEquals(await resolveExistingTeamSlug("org-c", "cs101-staff", octokit), "cs101-staff");
});

// Ambiguous string concatenation (org "a-b" + "-" + "c" === org "a" + "-" + "b-c") must not collide:
// each course resolves to its own team even in a warm isolate sharing the cache.
Deno.test("resolveExistingTeamSlug: distinct org/slug pairs don't collide in cache", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": (p) => ({ data: { id: 9, slug: `${p.org}::${p.team_slug}` } })
  });
  assertEquals(await resolveExistingTeamSlug("a-b", "c", octokit), "a-b::c");
  assertEquals(await resolveExistingTeamSlug("a", "b-c", octokit), "a::b-c");
});

// A transient (non-404) error must propagate rather than trigger the team-list fallback, so callers
// don't silently sync against the wrong (fallback literal) slug on a blip.
Deno.test("resolveExistingTeamSlug: non-404 error -> rethrows", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(500, "Server Error");
    }
  });
  await assertRejects(() => resolveExistingTeamSlug("org-d", "cs101-staff", octokit), RequestError);
});

// ── Looking up a GitHub login that may no longer exist ─────────────────────
// A 404 here means "this login doesn't exist", which is a fact about one person, not a GitHub
// failure. reinviteToOrgTeam relies on getting null (not a throw) so it can re-resolve the current
// login from the stored account id before giving up. Any other status has to propagate, or a blip
// would be misread as a deleted account.
Deno.test("getGitHubUserIfExists: login exists -> returns the response", async () => {
  const octokit = fakeOctokit({
    "GET /users/{username}": () => ({ data: { id: 1234, login: "some-student" } })
  });
  const user = await getGitHubUserIfExists(octokit, "some-student");
  assertEquals(user?.data.id, 1234);
});

Deno.test("getGitHubUserIfExists: 404 -> null", async () => {
  const octokit = fakeOctokit({
    "GET /users/{username}": () => {
      throw requestError(404, "Not Found");
    }
  });
  assertEquals(await getGitHubUserIfExists(octokit, "renamed-away"), null);
});

Deno.test("getGitHubUserIfExists: non-404 error -> rethrows", async () => {
  const octokit = fakeOctokit({
    "GET /users/{username}": () => {
      throw requestError(500, "Server Error");
    }
  });
  await assertRejects(() => getGitHubUserIfExists(octokit, "some-student"), RequestError);
});

// ── Public-vs-internal Supabase origin ──────────────────────────────────────
// Edge functions reach storage through the in-cluster Kong service, so anything
// handed to the GitHub Actions runner must carry the public origin instead —
// otherwise the runner dies on "getaddrinfo ENOTFOUND pawtograder-kong".
// toPublicSupabaseUrl rebases an already-signed URL; publicSupabaseUrl supplies
// the base the runner builds its own client from (GradeResponse.supabase_url).

function withSupabaseEnv(internal: string | undefined, pub: string | undefined, fn: () => void) {
  const prevInternal = Deno.env.get("SUPABASE_URL");
  const prevPublic = Deno.env.get("SUPABASE_PUBLIC_URL");
  const set = (k: string, v: string | undefined) => (v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v));
  set("SUPABASE_URL", internal);
  set("SUPABASE_PUBLIC_URL", pub);
  try {
    fn();
  } finally {
    set("SUPABASE_URL", prevInternal);
    set("SUPABASE_PUBLIC_URL", prevPublic);
  }
}

const KONG = "http://pawtograder-kong:8000";
const PUBLIC = "https://api.pawtograder.khoury.northeastern.edu";

Deno.test("publicSupabaseUrl: prefers SUPABASE_PUBLIC_URL over the in-cluster origin", () => {
  withSupabaseEnv(KONG, PUBLIC, () => assertEquals(publicSupabaseUrl(), PUBLIC));
});

// supabase.com hosting sets no SUPABASE_PUBLIC_URL because SUPABASE_URL is already public.
Deno.test("publicSupabaseUrl: falls back to SUPABASE_URL when no public origin is set", () => {
  withSupabaseEnv("https://abc.supabase.co", undefined, () =>
    assertEquals(publicSupabaseUrl(), "https://abc.supabase.co")
  );
});

Deno.test("toPublicSupabaseUrl: rebases a signed URL, preserving path and query", () => {
  withSupabaseEnv(KONG, PUBLIC, () =>
    assertEquals(
      toPublicSupabaseUrl(`${KONG}/storage/v1/object/sign/graders/a/b/archive.tgz?token=xyz`),
      `${PUBLIC}/storage/v1/object/sign/graders/a/b/archive.tgz?token=xyz`
    )
  );
});

// A trailing slash on the public origin must not produce a double slash in the path.
Deno.test("toPublicSupabaseUrl: strips trailing slashes from the public origin", () => {
  withSupabaseEnv(KONG, `${PUBLIC}/`, () =>
    assertEquals(toPublicSupabaseUrl(`${KONG}/storage/v1/x`), `${PUBLIC}/storage/v1/x`)
  );
});

// Leave anything that isn't ours alone — a GitHub tarball URL must pass through.
Deno.test("toPublicSupabaseUrl: no-op for URLs not on the internal origin", () => {
  withSupabaseEnv(KONG, PUBLIC, () =>
    assertEquals(
      toPublicSupabaseUrl("https://codeload.github.com/o/r/tar.gz/sha"),
      "https://codeload.github.com/o/r/tar.gz/sha"
    )
  );
});

// --- staff team roster: unknown must not read as empty ----------------------
//
// getTeamMembers used to return [] on 404, and that list is the only guard before
// syncRepoPermissions removes collaborators. An unreadable staff team therefore stripped
// every staff member from every repo the isolate touched.

Deno.test("getTeamMembers: returns lowercased logins", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}/members": () => [{ login: "Alice" }, { login: "BOB" }]
  });
  assertEquals(await getTeamMembers("org", "course-staff", octokit), ["alice", "bob"]);
});

Deno.test("getTeamMembers: members 404 + team absent throws TeamNotFoundError rather than returning []", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}/members": () => {
      throw requestError(404, "Not Found");
    },
    // The team itself is gone too, so this is the stable "never created" configuration and
    // callers are allowed to degrade.
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(404, "Not Found");
    }
  });
  await assertRejects(() => getTeamMembers("org", "course-staff", octokit), TeamNotFoundError);
});

// A members 404 on a team that DOES exist is transient, and it must not degrade: that is the path
// that skipped every removal while the caller recorded success, leaving a dropped student with
// write access and nothing scheduled to retry.
Deno.test("getTeamMembers: members 404 while the team exists throws TeamMembersUnreadableError", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}/members": () => {
      throw requestError(404, "Not Found");
    },
    "GET /orgs/{org}/teams/{team_slug}": () => ({ data: { slug: "course-staff" } })
  });
  const err = await assertRejects(() => getTeamMembers("org", "course-staff", octokit), TeamMembersUnreadableError);
  assertEquals(err instanceof TeamNotFoundError, false);
});

// If the probe itself fails for some other reason we still do not know which case this is, and
// unknown must not resolve to the degradable verdict.
Deno.test(
  "getTeamMembers: an inconclusive probe throws TeamMembersUnreadableError, not TeamNotFoundError",
  async () => {
    const octokit = fakeOctokit({
      "GET /orgs/{org}/teams/{team_slug}/members": () => {
        throw requestError(404, "Not Found");
      },
      "GET /orgs/{org}/teams/{team_slug}": () => {
        throw requestError(503, "Service Unavailable");
      }
    });
    await assertRejects(() => getTeamMembers("org", "course-staff", octokit), TeamMembersUnreadableError);
  }
);

Deno.test("getTeamMembers: non-404 errors propagate unchanged", async () => {
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}/members": () => {
      throw requestError(500, "Server Error");
    }
  });
  const err = await assertRejects(() => getTeamMembers("org", "course-staff", octokit));
  assertEquals(err instanceof TeamNotFoundError, false);
});

Deno.test("getTeamMembers: a 404 is not remembered as an empty roster", async () => {
  // The caller caches the resolved promise, so a 404 that resolved to [] would stick for the
  // isolate's lifetime. Throwing lets the cache's .catch evict it and the next call succeed.
  let calls = 0;
  const octokit = fakeOctokit({
    "GET /orgs/{org}/teams/{team_slug}/members": () => {
      calls++;
      if (calls === 1) throw requestError(404, "Not Found");
      return [{ login: "alice" }];
    },
    "GET /orgs/{org}/teams/{team_slug}": () => {
      throw requestError(404, "Not Found");
    }
  });
  await assertRejects(() => getTeamMembers("org", "course-staff", octokit), TeamNotFoundError);
  assertEquals(await getTeamMembers("org", "course-staff", octokit), ["alice"]);
});

Deno.test("computeCollaboratorRemovals: an unknown roster removes nobody", () => {
  assertEquals(
    computeCollaboratorRemovals({
      existingUsernames: ["ta1", "ta2", "student"],
      desiredUsernames: [],
      staffRoster: null,
      adminExclusions: []
    }),
    []
  );
});

Deno.test("computeCollaboratorRemovals: an empty roster is a real answer and permits removal", () => {
  assertEquals(
    computeCollaboratorRemovals({
      existingUsernames: ["stale"],
      desiredUsernames: [],
      staffRoster: [],
      adminExclusions: []
    }),
    ["stale"]
  );
});

Deno.test("computeCollaboratorRemovals: keeps desired, staff and excluded admins", () => {
  assertEquals(
    computeCollaboratorRemovals({
      existingUsernames: ["student", "ta1", "orgadmin", "stale"],
      desiredUsernames: ["student"],
      staffRoster: ["ta1"],
      adminExclusions: ["orgadmin"]
    }),
    ["stale"]
  );
});
