// Turn the OIDC claims of a grading run into the URL of the GitHub Actions run that made the request.
//
// Every OIDC-authenticated function already tagged `repository`, `run_id` and `run_attempt`
// separately, which is enough information but not enough *affordance*: triaging a Sentry event meant
// reading three tags, remembering the /actions/runs/<id>/attempts/<n> shape, and pasting a URL
// together by hand — per event. The claims are right there at the top of every handler, so the link
// may as well be built once and stamped where both audiences can reach it: a `gha_run_url` tag for
// Sentry, and a log line for whoever is tailing the function logs instead.
//
// Deliberately free of any Sentry import so it stays a pure unit under `deno test`; callers pass
// anything with `setTag`, which the real `Sentry.Scope` satisfies structurally.

/** The subset of `Sentry.Scope` this module needs. */
export interface TaggableScope {
  setTag(key: string, value: string): void;
}

/** The OIDC claims naming a run. Field names match the token, so callers can pass it straight through. */
export interface WorkflowRunRef {
  repository: string;
  run_id: string;
  run_attempt?: string;
}

/** Sentry tag under which the link is stamped. */
export const GHA_RUN_URL_TAG = "gha_run_url";

// GitHub owner and repo names; anything else is not ours to guess at. Rejecting an odd value yields
// no link, which is strictly better than emitting a plausible-looking URL built from an unexpected
// claim — the whole point of the tag is that clicking it lands on the right run.
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const NUMERIC_PATTERN = /^[0-9]+$/;

/**
 * The Actions run URL, or undefined when the claims cannot form one.
 *
 * A missing or unparseable `run_attempt` degrades to the plain run URL rather than dropping the link
 * — GitHub redirects that to the latest attempt, which is the right destination in the overwhelmingly
 * common case of a run that was never re-run.
 */
export function workflowRunUrl({ repository, run_id, run_attempt }: WorkflowRunRef): string | undefined {
  if (!REPOSITORY_PATTERN.test(repository ?? "") || !NUMERIC_PATTERN.test(run_id ?? "")) {
    return undefined;
  }
  const base = `https://github.com/${repository}/actions/runs/${run_id}`;
  const attempt = run_attempt ?? "";
  if (NUMERIC_PATTERN.test(attempt) && Number(attempt) > 0) {
    return `${base}/attempts/${attempt}`;
  }
  return base;
}

/**
 * Stamp the run link on the Sentry scope and echo it to the logs. Returns the URL so a caller can
 * reuse it (in a user-visible message, say) without rebuilding it.
 *
 * Call this once, immediately after decoding the token: the scope is threaded through the whole
 * handler, so every event the request goes on to report carries the tag.
 */
export function attachWorkflowRunLink(
  scope: TaggableScope | undefined,
  ref: WorkflowRunRef,
  label = "Triggered by GitHub Actions run"
): string | undefined {
  const url = workflowRunUrl(ref);
  if (!url) {
    return undefined;
  }
  scope?.setTag(GHA_RUN_URL_TAG, url);
  console.log(`${label}: ${url}`);
  return url;
}
