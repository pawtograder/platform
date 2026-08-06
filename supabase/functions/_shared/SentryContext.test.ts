/**
 * Unit tests for the Sentry identity mapping.
 *
 * The behaviour that matters: an event must never be labelled `production` just because nobody set
 * `ENVIRONMENT`, and the branch / PR / CI-run tags must be present whenever CI supplies them.
 *
 * Run from supabase/functions:  deno test --no-check _shared/SentryContext.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { type EnvReader, sentryIdentity } from "./SentryContext.ts";

const env =
  (vars: Record<string, string | undefined>): EnvReader =>
  (key) =>
    vars[key];

Deno.test("an e2e-local run is identifiable by branch, PR and CI run", () => {
  const id = sentryIdentity(
    env({
      DEPLOY_KIND: "e2e-local",
      DEPLOY_BRANCH: "fix/bugsink-dev-noise-and-502-conflation",
      DEPLOY_PR: "912",
      DEPLOY_RUN_ID: "31109237673",
      DEPLOY_RUN_ATTEMPT: "1",
      GIT_COMMIT_SHA: "018ae6024fbc1234567890abcdef1234567890ab"
    })
  );
  assertEquals(id.environment, "e2e-local");
  assertEquals(id.initialScope.tags, {
    deploy_kind: "e2e-local",
    branch: "fix/bugsink-dev-noise-and-502-conflation",
    pr: "912",
    ci_run: "31109237673-1",
    commit: "018ae60"
  });
  assertEquals(id.release, "018ae6024fbc1234567890abcdef1234567890ab");
});

Deno.test("environment never silently becomes production", () => {
  // Omitting `environment` from Sentry.init makes Sentry default it to "production", which is how the
  // same e2e run reported 21 events as development and 21 as production.
  assertEquals(sentryIdentity(env({})).environment, "development");
  assertEquals(sentryIdentity(env({ DEPLOY_KIND: "preview" })).environment, "preview");
  // An explicit ENVIRONMENT still wins, so staging/production deploys are unaffected.
  assertEquals(sentryIdentity(env({ ENVIRONMENT: "production", DEPLOY_KIND: "preview" })).environment, "production");
});

Deno.test("release honours the existing precedence", () => {
  assertEquals(sentryIdentity(env({ RELEASE_VERSION: "v1.2.3" })).release, "v1.2.3");
  assertEquals(sentryIdentity(env({ GIT_COMMIT_SHA: "abc1234" })).release, "abc1234");
  assertEquals(sentryIdentity(env({ DENO_DEPLOYMENT_ID: "dep-9" })).release, "dep-9");
  assertEquals(sentryIdentity(env({ RELEASE_VERSION: "v1", GIT_COMMIT_SHA: "abc1234" })).release, "v1");
  assertEquals(sentryIdentity(env({})).release, undefined);
});

Deno.test("blank and whitespace-only values are treated as absent", () => {
  // CI writes `DEPLOY_PR=` for push-triggered runs that have no PR; an empty tag is worse than none.
  const id = sentryIdentity(env({ DEPLOY_BRANCH: "staging", DEPLOY_PR: "", DEPLOY_RUN_ID: "   " }));
  assertEquals(id.initialScope.tags, { branch: "staging" });
  assertEquals(id.release, undefined);
});

Deno.test("a run id without an attempt still tags", () => {
  assertEquals(sentryIdentity(env({ DEPLOY_RUN_ID: "42" })).initialScope.tags.ci_run, "42");
});

Deno.test("a non-sha release does not produce a bogus short commit", () => {
  // Tag versions are not commits; slicing one to 7 chars would read as a sha that does not exist.
  assertEquals(sentryIdentity(env({ RELEASE_VERSION: "v1.2.3" })).initialScope.tags.commit, undefined);
  assertEquals(sentryIdentity(env({ GIT_COMMIT_SHA: "018ae6024f" })).initialScope.tags.commit, "018ae60");
});
