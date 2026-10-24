/**
 * Unit tests for Sentry fingerprint normalization.
 *
 * Every message below is a verbatim `calculated_value` pulled from the Bugsink "Dev" project, where
 * it had split one defect across many issues. The assertions are therefore the actual contract:
 * these specific strings must collapse to one group, and messages that are already stable must be
 * left on Sentry's default grouping so they keep their issue history.
 *
 * Run from supabase/functions:  deno test --allow-env _shared/SentryFingerprint.test.ts
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type FingerprintableEvent,
  fingerprintForEvent,
  normalizeErrorMessage,
  normalizeEventFingerprint
} from "./SentryFingerprint.ts";

Deno.test("push-webhook head lookup: every student repo collapses to one group", () => {
  const message = (repo: string, sha: string) =>
    `Could not resolve the current head of pawtograder-playground/${repo} to check whether ${sha} is superseded ` +
    `(Not Found - https://docs.github.com/rest/repos/repos#get-a-repository); rejecting this delivery so GitHub retries it`;

  const a = normalizeErrorMessage(message("test-e2e-student-repo--msh98vk8kvtq7w", "deadbeefmsh98vk8kvtq7w"));
  const b = normalizeErrorMessage(message("test-e2e-student-repo--mshhaeuua6ryje", "deadbeefmshhaeuua6ryje"));
  assertEquals(a, b);
  // The doc link identifies which GitHub call failed, so it has to survive normalization.
  assert(a.includes("https://docs.github.com/rest/repos/repos#get-a-repository"), a);
});

Deno.test("octokit lookup failure: per-class org and per-repo name collapse to one group", () => {
  const messages = [
    "Get file from repo failed: No octokit found for e2e-org-215/handout-from-ui",
    "Get file from repo failed: No octokit found for e2e-org-37/grader-from-ui",
    "Get file from repo failed: No octokit found for e2e-org-281/handout-default"
  ].map(normalizeErrorMessage);
  assertEquals(new Set(messages).size, 1);
});

Deno.test("pgmq poison message: the varying read count collapses", () => {
  const messages = [10, 11, 13].map((n) =>
    normalizeErrorMessage(`pgmq read_ct=${n} exceeded max=10 without archive — DLQing as poison message`)
  );
  assertEquals(new Set(messages).size, 1);
});

Deno.test("handout repo creation: run timestamps and class ids collapse", () => {
  // These fixture names embed a slash-and-#-laden date, which is not a legal GitHub repo name and so
  // is not matched as one slug. The date and the class/assignment ids still normalize away, which is
  // the variance that mattered; the 4-char per-run slug (xpy3/lbxf) is deliberately left alone —
  // a rule broad enough to eat short random tokens would also merge genuinely distinct errors.
  const message = (slug: string, stamp: string) =>
    `Repo pawtograder-playground/e2e-ignore-repo-config-e2e-${stamp}#${slug}-4-37-handout-cp-${slug}-4 ` +
    `was created but never received content from pawtograder/template-assignment-handout`;
  assertEquals(
    normalizeErrorMessage(message("xpy3", "09/07/26-20:34:09")),
    normalizeErrorMessage(message("xpy3", "10/07/26-13:54:33"))
  );
});

Deno.test("uuids and bare ids in messages collapse", () => {
  assertEquals(
    normalizeErrorMessage('NaN score for expression assignments("assignment-42")'),
    normalizeErrorMessage('NaN score for expression assignments("assignment-7")')
  );
  assertEquals(
    normalizeErrorMessage("Row 69d87952-ac23-47f2-a465-0c06aa98354b is stuck"),
    normalizeErrorMessage("Row 2e85ce35-ad14-4d78-abc4-ec922c8e3386 is stuck")
  );
});

Deno.test("distinct failures are NOT merged", () => {
  const a = normalizeErrorMessage('Failed to insert text submission file "Main.java": upstream error');
  const b = normalizeErrorMessage(
    "Could not resolve the current head of org/repo to check whether abc1234 is superseded"
  );
  assert(a !== b);
});

Deno.test("stable messages keep Sentry's default grouping", () => {
  // Nothing volatile to replace, so forcing a fingerprint would only detach it from its history.
  assertEquals(fingerprintForEvent({ exception: { values: [{ type: "Error", value: "Security Error" }] } }), null);
  assertEquals(fingerprintForEvent({ message: "class_id is required" }), null);
});

Deno.test("an explicit call-site fingerprint always wins", () => {
  const event: FingerprintableEvent = {
    fingerprint: ["github-rate-limit"],
    exception: { values: [{ type: "Error", value: "rate limited on repo owner/name-123" }] }
  };
  assertEquals(fingerprintForEvent(event), null);
  assertEquals(normalizeEventFingerprint(event).fingerprint, ["github-rate-limit"]);
});

Deno.test("fingerprint keys on type and the innermost in-app frame", () => {
  const event: FingerprintableEvent = {
    exception: {
      values: [
        {
          type: "AggregateError",
          value: "Could not resolve the current head of org/test-e2e-student-repo--msh98vk8kvtq7w",
          stacktrace: {
            frames: [
              { filename: "ext:core/01_core.js", function: "eventLoopTick", in_app: false },
              { filename: "/var/tmp/x/functions/github-repo-webhook/index.ts", function: "handlePush", in_app: true },
              { filename: "ext:runtime/http.js", function: "mapped", in_app: false }
            ]
          }
        }
      ]
    }
  };
  const fp = fingerprintForEvent(event)!;
  assertEquals(fp[0], "AggregateError");
  assertEquals(fp[1], "github-repo-webhook/index.ts:handlePush");
  assert(fp[2].includes("<repo>"), fp[2]);
});

Deno.test("HTTP status codes survive normalization so 404 and 500 stay separate", () => {
  // GitHubSyncHelpers: `Failed to download '${path}' from ${repo}: ${response.status}`. Same frame and
  // same message shape, but a missing file and an upstream fault need different fixes.
  const download = (status: number) =>
    normalizeErrorMessage(`Failed to download 'src/Main.java' from pawtograder-playground/handout: ${status}`);
  assert(download(404) !== download(500));
  assert(download(404).includes("<status:404>"), download(404));
  // React error codes benefit the same way.
  assert(
    normalizeErrorMessage("Minified React error #418; visit https://react.dev/errors/418") !==
      normalizeErrorMessage("Minified React error #423; visit https://react.dev/errors/423")
  );
});

Deno.test("status-shaped digits inside stack traces are still collapsed", () => {
  // The rule is positional on purpose: chunk names and line numbers land in the 4xx/5xx range too, and
  // preserving those would split one group across every build.
  assertEquals(
    normalizeErrorMessage("TypeError: fetch failed\n    at async b (/app/.next/server/chunks/476.js:54:21071)"),
    normalizeErrorMessage("TypeError: fetch failed\n    at async b (/app/.next/server/chunks/512.js:54:33258)")
  );
  // And a two-digit count is not a status code.
  assertEquals(
    normalizeErrorMessage("pgmq read_ct=10 exceeded max=10"),
    normalizeErrorMessage("pgmq read_ct=13 exceeded max=10")
  );
});

Deno.test("linked errors fingerprint on the captured wrapper, not its first child", () => {
  // Sentry's LinkedErrors prepends the cause chain, so the captured exception is LAST. Verified against
  // a real Dev event: values = [Error, AggregateError] for a captured AggregateError.
  // Shape taken from the real "Could not resolve the current head" events: the wrapper carries the repo
  // and the child is whatever octokit threw, with a different type and a different innermost frame.
  const linked = (repo: string, childType: string, childFn: string): FingerprintableEvent => ({
    exception: {
      values: [
        {
          type: childType,
          value: "Not Found - https://docs.github.com/rest/repos/repos#get-a-repository",
          stacktrace: {
            frames: [{ filename: "/x/functions/_shared/GitHubWrapper.ts", function: childFn, in_app: true }]
          }
        },
        {
          type: "AggregateError",
          value: `Could not resolve the current head of pawtograder-playground/${repo}; rejecting this delivery`,
          stacktrace: {
            frames: [{ filename: "/x/functions/github-repo-webhook/index.ts", function: "onPush", in_app: true }]
          }
        }
      ]
    }
  });
  const a = fingerprintForEvent(linked("test-e2e-student-repo--msh98vk8kvtq7w", "HttpError", "getRepo"))!;
  const b = fingerprintForEvent(linked("test-e2e-student-repo--mshhaeuua6ryje", "RequestError", "resolveHead"))!;
  // Keyed on the captured wrapper, so neither the repo nor a differing child splits the group.
  assertEquals(a, b);
  assertEquals(a[0], "AggregateError");
  assertEquals(a[1], "github-repo-webhook/index.ts:onPush");
});

Deno.test("a stable wrapper message keeps default grouping even when a child varies", () => {
  // Bugsink's own default grouping already keys on the captured exception, so there is nothing to
  // correct here — and forcing a fingerprint would detach the issue from its history.
  const linked = (childFile: string): FingerprintableEvent => ({
    exception: {
      values: [
        { type: "Error", value: `Failed to insert text submission file "${childFile}"` },
        { type: "AggregateError", value: "An invalid response was received from the upstream server" }
      ]
    }
  });
  assertEquals(fingerprintForEvent(linked("Main.java")), null);
});

Deno.test("normalizeEventFingerprint stamps the event in place and returns it", () => {
  const event: FingerprintableEvent = { message: "queue length 42 exceeded" };
  assertEquals(normalizeEventFingerprint(event), event);
  assertEquals(event.fingerprint, ["message", "queue length <n> exceeded"]);
});
