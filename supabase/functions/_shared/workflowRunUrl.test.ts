import { assertEquals } from "jsr:@std/assert@^1";
import { attachWorkflowRunLink, GHA_RUN_URL_TAG, workflowRunUrl } from "./workflowRunUrl.ts";

function fakeScope() {
  const tags: Record<string, string> = {};
  return {
    tags,
    setTag(key: string, value: string) {
      tags[key] = value;
    }
  };
}

Deno.test("workflowRunUrl: builds an attempt-specific URL", () => {
  assertEquals(
    workflowRunUrl({ repository: "pawtograder-playground/test-repo", run_id: "123", run_attempt: "2" }),
    "https://github.com/pawtograder-playground/test-repo/actions/runs/123/attempts/2"
  );
});

Deno.test("workflowRunUrl: falls back to the run URL when the attempt is absent or unusable", () => {
  const base = "https://github.com/org/repo/actions/runs/9";
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "9" }), base);
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "9", run_attempt: "" }), base);
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "9", run_attempt: "0" }), base);
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "9", run_attempt: "latest" }), base);
});

Deno.test("workflowRunUrl: accepts dots, dashes and underscores in repo names", () => {
  assertEquals(
    workflowRunUrl({ repository: "neu-cs2100/hw1_solution.v2", run_id: "1", run_attempt: "1" }),
    "https://github.com/neu-cs2100/hw1_solution.v2/actions/runs/1/attempts/1"
  );
});

Deno.test("workflowRunUrl: returns undefined rather than a plausible-but-wrong URL", () => {
  // A wrong link is worse than no link, so anything unexpected is rejected outright.
  assertEquals(workflowRunUrl({ repository: "no-slash", run_id: "1" }), undefined);
  assertEquals(workflowRunUrl({ repository: "org/repo/extra", run_id: "1" }), undefined);
  assertEquals(workflowRunUrl({ repository: "org/../../etc", run_id: "1" }), undefined);
  assertEquals(workflowRunUrl({ repository: "org/re po", run_id: "1" }), undefined);
  assertEquals(workflowRunUrl({ repository: "", run_id: "1" }), undefined);
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "not-a-number" }), undefined);
  assertEquals(workflowRunUrl({ repository: "org/repo", run_id: "" }), undefined);
});

Deno.test("attachWorkflowRunLink: tags the scope and returns the URL", () => {
  const scope = fakeScope();
  const url = attachWorkflowRunLink(scope, { repository: "org/repo", run_id: "7", run_attempt: "3" });
  assertEquals(url, "https://github.com/org/repo/actions/runs/7/attempts/3");
  assertEquals(scope.tags[GHA_RUN_URL_TAG], url);
});

Deno.test("attachWorkflowRunLink: leaves the scope untagged when no URL can be built", () => {
  const scope = fakeScope();
  assertEquals(attachWorkflowRunLink(scope, { repository: "bogus", run_id: "x" }), undefined);
  assertEquals(scope.tags, {});
});

Deno.test("attachWorkflowRunLink: tolerates a missing scope", () => {
  assertEquals(
    attachWorkflowRunLink(undefined, { repository: "org/repo", run_id: "7" }),
    "https://github.com/org/repo/actions/runs/7"
  );
});
