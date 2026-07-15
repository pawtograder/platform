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
const { assertSourceNotEmpty, getTeamAndCreateIfNeeded, isRepoEmpty, isTeamAlreadyExistsError, NonRetryableRepoError } =
  await import("./GitHubWrapper.ts");

type Handler = (params: Record<string, unknown>) => unknown;

function fakeOctokit(handlers: Record<string, Handler>): Octokit {
  return {
    request: async (route: string, params: Record<string, unknown>) => {
      const h = handlers[route];
      if (!h) throw new Error(`unexpected route: ${route}`);
      return await h(params);
    }
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
