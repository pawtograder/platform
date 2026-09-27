/**
 * Shared Sentry identity: which build, which branch, which CI run produced an event.
 *
 * Today a Dev-project event is nearly anonymous. Measured over 46 recent events:
 *
 *   - `release` was null on 45 of 46. Every init site reads
 *     `RELEASE_VERSION || GIT_COMMIT_SHA || DENO_DEPLOYMENT_ID`, and the e2e job sets none of them.
 *   - `environment` was a 21/21 development/production split *within the same run*, because some init
 *     sites pass `environment: ENVIRONMENT || "development"` and others omit the key entirely, which
 *     makes Sentry default it to "production". The value therefore says which function reported, not
 *     which deployment.
 *   - Branch and PR appear nowhere. The CI run id is recoverable, but only as an accident: the
 *     compose project name (`SUPABASE_PROJECT: pawtograder-platform-<run_id>-<attempt>` in
 *     deploy.yml) lands inside the `URL` tag, so it exists only on events from functions that go
 *     through wrapRequestHandler — not on queue workers or webhook handlers — and cannot be filtered
 *     on as a tag.
 *
 * So triaging "is this from my branch or from staging?" meant reading a hostname out of a URL. This
 * module centralizes the answer and stamps it as real tags. The env-var contract is set by
 * `.github/workflows/deploy.yml` (e2e-local) and the Helm chart (`_edge-functions-workload.tpl`, for
 * k8s previews and staging).
 *
 * `readEnv` is injectable so the mapping is unit-testable without mutating the process environment.
 */

/** Reads one environment variable. Injectable for tests. */
export type EnvReader = (key: string) => string | undefined;

const denoEnv: EnvReader = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    // --allow-env not granted (some scripts run sandboxed); identity is a nice-to-have, not fatal.
    return undefined;
  }
};

/** The subset of Sentry.init options this module owns. */
export interface SentryIdentity {
  release: string | undefined;
  environment: string;
  initialScope: { tags: Record<string, string> };
}

/**
 * Build the release/environment/tags triple for `Sentry.init`.
 *
 * `environment` resolves in order: explicit `ENVIRONMENT`, then `DEPLOY_KIND` (which CI sets per
 * deploy target), then "development". It never falls through to Sentry's implicit "production" —
 * mislabelling an e2e run as production is what made the field useless.
 */
export function sentryIdentity(readEnv: EnvReader = denoEnv): SentryIdentity {
  const value = (key: string): string | undefined => {
    const raw = readEnv(key);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  };

  const release = value("RELEASE_VERSION") ?? value("GIT_COMMIT_SHA") ?? value("DENO_DEPLOYMENT_ID");
  const deployKind = value("DEPLOY_KIND");
  const environment = value("ENVIRONMENT") ?? deployKind ?? "development";

  const tags: Record<string, string> = {};
  if (deployKind) tags.deploy_kind = deployKind;

  const branch = value("DEPLOY_BRANCH");
  if (branch) tags.branch = branch;

  const pr = value("DEPLOY_PR");
  if (pr) tags.pr = pr;

  // Run id and attempt as one tag: the attempt alone is meaningless, and the pair is what identifies
  // a job in the Actions UI (github.com/<repo>/actions/runs/<run_id>/attempts/<attempt>).
  const runId = value("DEPLOY_RUN_ID");
  if (runId) {
    const attempt = value("DEPLOY_RUN_ATTEMPT");
    tags.ci_run = attempt ? `${runId}-${attempt}` : runId;
  }

  // Short commit for at-a-glance reading; `release` keeps the full value for Bugsink's release view.
  const commit = value("GIT_COMMIT_SHA") ?? value("RELEASE_VERSION");
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) tags.commit = commit.slice(0, 7);

  return { release, environment, initialScope: { tags } };
}
