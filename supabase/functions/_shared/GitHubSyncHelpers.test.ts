/**
 * Unit tests for the compare-and-swap branch reset.
 *
 * This is the one destructive write in the handout sync: it discards whatever is on the sync
 * branch. `assertSyncBranchSafeToReset` decides whether that is allowed, and everything
 * between that decision and the write is a window where a student's push can be accepted and
 * then thrown away. `resetRefWithExpectedHead` closes the window by handing GitHub the head it
 * was authorized against, as `beforeOid`, so the server does the comparing.
 *
 * What the tests pin is mostly what it does NOT do. It returns false rather than throwing for
 * every failure, because the caller's fallback is the REST path, which re-reads the branch and
 * refuses the write if it moved. A rejected `beforeOid` therefore reaches the same refusal by
 * another route, and an unavailable mutation reaches exactly the behavior this sync had before
 * the mutation was added. That is the property that made it safe to put an untested GraphQL
 * call on this path at all, so it is the property worth a test.
 *
 * It takes an Octokit as a parameter, so a fake with a `graphql` method drives it.
 *
 * Run from supabase/functions:
 *   deno test --no-check --allow-all _shared/GitHubSyncHelpers.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";

// GitHubWrapper, which this module imports, builds a GitHub App at import time and needs a
// non-empty private key. Nothing under test authenticates. Set it before the dynamic import;
// a static import would hoist above this line.
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", Deno.env.get("GITHUB_PRIVATE_KEY_STRING") || "test-placeholder-key");
const { updateRefWithExpectedHead, GIT_NULL_OID } = await import("./GitHubSyncHelpers.ts");

const EXPECTED = "a".repeat(40);
const TARGET = "b".repeat(40);

type GraphqlCall = { query: string; variables: Record<string, unknown> };

/**
 * An Octokit whose `graphql` answers the repository-id query and then runs `onMutation`.
 * Every call is recorded, because the number of them is part of what is under test.
 */
function fakeOctokit(onMutation: (call: GraphqlCall) => unknown) {
  const calls: GraphqlCall[] = [];
  const octokit = {
    graphql: (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes("repository(owner:")) {
        return Promise.resolve({ repository: { id: "R_node_id" } });
      }
      return Promise.resolve(onMutation({ query, variables }));
    }
  };
  // The helper only ever calls `graphql`; the parameter type is the full Octokit.
  return { octokit: octokit as unknown as Parameters<typeof updateRefWithExpectedHead>[0], calls };
}

Deno.test("a successful swap reports done, and tells GitHub the head it was authorized against", async () => {
  const { octokit, calls } = fakeOctokit(() => ({ updateRefs: { clientMutationId: null } }));
  assertEquals(await updateRefWithExpectedHead(octokit, "org/repo-swap-ok", "sync-to-abc1234", EXPECTED, TARGET), true);

  const mutation = calls.find((c) => c.query.includes("updateRefs"));
  const input = mutation?.variables.input as {
    repositoryId: string;
    refUpdates: { name: string; afterOid: string; beforeOid: string; force: boolean }[];
  };
  assertEquals(input.repositoryId, "R_node_id");
  assertEquals(input.refUpdates.length, 1);
  // Fully qualified: GraphQL takes the ref name, not the branch name REST wants.
  assertEquals(input.refUpdates[0].name, "refs/heads/sync-to-abc1234");
  // beforeOid is the whole point. afterOid without it is the racy REST write in a new coat.
  assertEquals(input.refUpdates[0].beforeOid, EXPECTED);
  assertEquals(input.refUpdates[0].afterOid, TARGET);
  assertEquals(input.refUpdates[0].force, true);
});

// The rejection case. GitHub refusing the swap means the branch moved after it was
// authorized, which is precisely the push this exists to protect. Reporting false sends the
// caller to the REST path, which re-reads the ref and raises SyncBranchMovedError: the student
// keeps their commit and the instructor is told why the sync stopped.
Deno.test("a rejected beforeOid reports not-done rather than throwing", async () => {
  const { octokit } = fakeOctokit(() => {
    throw new Error("Reference cannot be updated: expected object does not match");
  });
  assertEquals(
    await updateRefWithExpectedHead(octokit, "org/repo-swap-rejected", "sync-to-abc1234", EXPECTED, TARGET),
    false
  );
});

// A deployment where the mutation is not available -- GitHub Enterprise Server, the feature
// flag withdrawn, the schema changed under us -- has to degrade to the behavior that shipped
// before it, not park every repository whose sync branch already exists.
Deno.test("an unavailable mutation reports not-done, so the caller falls back", async () => {
  const { octokit } = fakeOctokit(() => {
    throw new Error("Field 'updateRefs' doesn't exist on type 'Mutation'");
  });
  assertEquals(
    await updateRefWithExpectedHead(octokit, "org/repo-swap-unsupported", "sync-to-abc1234", EXPECTED, TARGET),
    false
  );
});

// A repository the id query cannot answer for is not a repository we can mutate by node id.
// Nothing is attempted, and the caller falls back.
Deno.test("no repository id means no mutation is attempted at all", async () => {
  const calls: GraphqlCall[] = [];
  const octokit = {
    graphql: (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return Promise.resolve({ repository: null });
    }
  } as unknown as Parameters<typeof updateRefWithExpectedHead>[0];
  assertEquals(
    await updateRefWithExpectedHead(octokit, "org/repo-swap-no-id", "sync-to-abc1234", EXPECTED, TARGET),
    false
  );
  assertEquals(calls.filter((c) => c.query.includes("updateRefs")).length, 0);
});

// A delete is an update to the null oid, and it is the same guarded operation: the empty-sync
// cleanup used to DELETE the ref unconditionally, which took a student's push with it if one
// landed after the branch was made.
Deno.test("deleting a branch is the same swap, against the null oid", async () => {
  const { octokit, calls } = fakeOctokit(() => ({ updateRefs: { clientMutationId: null } }));
  assertEquals(
    await updateRefWithExpectedHead(octokit, "org/repo-swap-delete", "sync-to-abc1234", EXPECTED, GIT_NULL_OID),
    true
  );
  const input = calls.find((c) => c.query.includes("updateRefs"))?.variables.input as {
    refUpdates: { afterOid: string; beforeOid: string }[];
  };
  assertEquals(input.refUpdates[0].afterOid, "0".repeat(40));
  assertEquals(input.refUpdates[0].beforeOid, EXPECTED);
});

// Node ids are stable for the life of a repository, and a sync that reset two branches would
// otherwise pay for the same lookup twice.
Deno.test("the repository id is looked up once and reused", async () => {
  const { octokit, calls } = fakeOctokit(() => ({ updateRefs: { clientMutationId: null } }));
  const repo = "org/repo-swap-cached";
  assertEquals(await updateRefWithExpectedHead(octokit, repo, "sync-to-abc1234", EXPECTED, TARGET), true);
  assertEquals(await updateRefWithExpectedHead(octokit, repo, "sync-to-def5678", EXPECTED, TARGET), true);
  assertEquals(calls.filter((c) => c.query.includes("repository(owner:")).length, 1);
  assertEquals(calls.filter((c) => c.query.includes("updateRefs")).length, 2);
});
