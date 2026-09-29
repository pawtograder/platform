/**
 * Retention purge for bug reports (ADR 1): feedback and replays tagged with a `class_id` are deleted
 * from Sentry once the class ended more than {@link RETENTION_GRACE_DAYS} days ago.
 *
 * Kept free of Deno.serve, Supabase and env access so the unit tests can drive it against a mocked
 * Sentry API. index.ts wires it to the database and the environment.
 *
 * Safety rules, each enforced here and not left to Sentry's search:
 *   - Nothing is deleted for a class unless its end_date is past the grace period, checked again in
 *     this file even though the candidate RPC already filters on it.
 *   - An item is deleted only when its own `class_id` tag equals the class's id exactly: every
 *     value the item carries must be that id. Sentry's `class_id:N` search is an exact match today
 *     (checked on 26.5: `class_id:99900` does not match 999001), but a wildcard, a changed search
 *     parser or a mis-built query must not widen a delete. An item with no `class_id` tag never
 *     passes, so reports filed outside a course are never touched.
 *   - Feedback only: an issue that isn't in the feedback category is left alone even if it carries
 *     the tag.
 *
 * Replays are deleted one by one (DELETE /projects/{org}/{project}/replays/{id}/) rather than with
 * the bulk job (POST …/replays/jobs/delete/). The bulk job deletes whatever its query matches on the
 * server, so the exact-tag guard above could not run before the delete; it also needs a time range
 * and returns before it finishes, so the counts would come from polling a job. Listing first and
 * deleting by id keeps the guard in front of every delete and makes the logged counts exact. It
 * costs one request per replay, which is small next to a class's report volume.
 */

/** Days after `classes.end_date` that bug reports are kept (ADR 1). */
export const RETENTION_GRACE_DAYS = 30;

/**
 * How far back to search Sentry, and how long after the grace period a class keeps being swept for
 * reports filed late (for example from an archived course page). It must be at least Sentry's
 * `sentry.cleanup.days` (about 150 on our installs), because data older than that is already gone
 * and is what lets the job stop visiting a class. 365 leaves room for a larger cleanup setting.
 */
export const SENTRY_LOOKBACK_DAYS = 365;

/** Items per list page. Sentry caps per_page at 100. */
const PAGE_SIZE = 100;
/** Pages per list before a class is left for the next run, so one runaway query can't eat the run. */
const MAX_PAGES = 50;
/** Ids per bulk issue delete. Sentry accepts 1000; 100 keeps the query string well under proxy URL limits. */
const ISSUE_DELETE_BATCH = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One list's items. `complete` is false when the page cap cut it short. */
export type Listing<T> = { items: T[]; complete: boolean };

export type PurgeCandidate = { class_id: number; end_date: string };

export type SentryPurgeConfig = {
  /** Base URL of the Sentry install, without /api/0. */
  baseUrl: string;
  org: string;
  /** Project slug that holds the replays (pawtograder-web). */
  replayProject: string;
  /** Delete-scoped token (SENTRY_PURGE_TOKEN). */
  token: string;
  /** When set, only items from this Sentry environment are listed. */
  environment?: string;
};

export type RetryOptions = {
  /** Attempts per request for 429 and 5xx, including the first. */
  maxAttempts: number;
  /** Longest single wait for a 429 before giving up on the run. */
  maxWaitMs: number;
  /** Base backoff for 5xx and network errors, doubled per attempt. */
  backoffMs: number;
};

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 5, maxWaitMs: 60_000, backoffMs: 1_000 };

/** Why a class stopped. `fatal` errors stop the whole run, because the next class would fail the same way. */
export class SentryApiError extends Error {
  constructor(
    readonly step: string,
    readonly status: number | null,
    readonly fatal: boolean
  ) {
    // Status and step only: the URL carries ids, which the logs must not.
    super(`Sentry ${step} failed${status === null ? " (network)" : ` with HTTP ${status}`}`);
    this.name = "SentryApiError";
  }
}

/** True once `end_date` + {@link RETENTION_GRACE_DAYS} days is in the past. end_date is read as UTC midnight. */
export function isPastRetention(endDate: string, now: Date, graceDays = RETENTION_GRACE_DAYS): boolean {
  const end = Date.parse(`${endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end)) return false;
  return end + graceDays * DAY_MS < now.getTime();
}

/** Returns the `cursor` of the Link header's `rel="next"` entry when Sentry says it has results. */
export function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    const m = part.match(/cursor="([^"]+)"/);
    return m ? m[1] : null;
  }
  return null;
}

/** Seconds to wait before retrying a 429, from Retry-After or Sentry's rate-limit reset header. */
function retryAfterMs(res: Response, now: number): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim())) return Math.ceil(Number(retryAfter) * 1000);
  const reset = res.headers.get("x-sentry-rate-limit-reset");
  if (reset && /^\d+(\.\d+)?$/.test(reset.trim())) return Math.max(0, Math.ceil(Number(reset) * 1000 - now));
  return null;
}

/** The slice of `fetch` the purge uses, so tests can pass a fake without matching every overload. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The few Sentry endpoints the purge needs, with retry and rate-limit handling. */
export class SentryPurgeApi {
  private readonly base: string;
  private readonly retry: RetryOptions;

  constructor(
    private readonly cfg: SentryPurgeConfig,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = realSleep,
    retry: Partial<RetryOptions> = {}
  ) {
    this.base = cfg.baseUrl.replace(/\/+$/, "") + "/api/0";
    this.retry = { ...DEFAULT_RETRY, ...retry };
  }

  private async request(
    step: string,
    method: string,
    path: string,
    params: [string, string][] = []
  ): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.base}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { method, headers: { Authorization: `Bearer ${this.cfg.token}` } });
      } catch {
        if (attempt >= this.retry.maxAttempts) throw new SentryApiError(step, null, true);
        await this.sleep(this.retry.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 429) {
        await res.body?.cancel();
        const wait = retryAfterMs(res, Date.now()) ?? this.retry.backoffMs * 2 ** (attempt - 1);
        // A wait longer than the cap, or too many in a row, means the budget is spent for this run.
        if (attempt >= this.retry.maxAttempts || wait > this.retry.maxWaitMs) {
          throw new SentryApiError(step, 429, true);
        }
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        if (attempt >= this.retry.maxAttempts) throw new SentryApiError(step, res.status, false);
        await this.sleep(this.retry.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        // A bad or under-scoped token fails every class the same way.
        throw new SentryApiError(step, res.status, res.status === 401 || res.status === 403);
      }
      return res;
    }
  }

  private async json<T>(step: string, path: string, params: [string, string][] = []) {
    const res = await this.request(step, "GET", path, params);
    return { body: (await res.json()) as T, link: res.headers.get("link") };
  }

  /**
   * Lists every page of a cursor-paginated endpoint. `complete` is false when the page cap was
   * hit; `items` then holds the pages listed so far, which the caller still acts on.
   */
  private async listAll<T>(
    step: string,
    path: string,
    params: [string, string][],
    items: (body: unknown) => T[]
  ): Promise<Listing<T>> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const p: [string, string][] = cursor ? [...params, ["cursor", cursor]] : params;
      let res: { body: unknown; link: string | null };
      try {
        res = await this.json<unknown>(step, path, p);
      } catch (e) {
        // Sentry answers 404 for an environment it has never seen, which means nothing to delete.
        if (e instanceof SentryApiError && e.status === 404 && this.cfg.environment && page === 0) {
          return { items: [], complete: true };
        }
        throw e;
      }
      const { body, link } = res;
      out.push(...items(body));
      cursor = nextCursor(link);
      if (!cursor) return { items: out, complete: true };
    }
    return { items: out, complete: false };
  }

  private scopeParams(): [string, string][] {
    const p: [string, string][] = [["statsPeriod", `${SENTRY_LOOKBACK_DAYS}d`]];
    if (this.cfg.environment) p.push(["environment", this.cfg.environment]);
    return p;
  }

  /** Numeric id of the replay project, which the replay search needs. */
  async replayProjectId(): Promise<string> {
    const { body } = await this.json<{ id?: string | number }>(
      "resolve_project",
      `/projects/${encodeURIComponent(this.cfg.org)}/${encodeURIComponent(this.cfg.replayProject)}/`
    );
    if (body.id === undefined || body.id === null) throw new SentryApiError("resolve_project", 200, true);
    return String(body.id);
  }

  /** Feedback issue ids whose search matches the class. The caller still checks the tag per issue. */
  async listFeedbackIssues(classId: number) {
    return await this.listAll<{ id: string; category: string | undefined }>(
      "list_feedback",
      `/organizations/${encodeURIComponent(this.cfg.org)}/issues/`,
      [
        ["project", "-1"],
        ...this.scopeParams(),
        ["query", `issue.category:feedback class_id:"${classId}"`],
        ["per_page", String(PAGE_SIZE)]
      ],
      (body) =>
        Array.isArray(body)
          ? body.map((i: { id: string | number; issueCategory?: string }) => ({
              id: String(i.id),
              category: i.issueCategory
            }))
          : []
    );
  }

  /** True when every `class_id` value on the issue is exactly `classId`. */
  async feedbackTagMatches(issueId: string, classId: number): Promise<boolean> {
    let res: Response;
    try {
      res = await this.request(
        "check_feedback_tag",
        "GET",
        `/organizations/${encodeURIComponent(this.cfg.org)}/issues/${encodeURIComponent(issueId)}/tags/class_id/`
      );
    } catch (e) {
      // No class_id tag on the issue: Sentry answers 404. That is a mismatch, not a failure.
      if (e instanceof SentryApiError && e.status === 404) return false;
      throw e;
    }
    const tag = (await res.json()) as { uniqueValues?: number; topValues?: { value?: string }[] };
    const values = tag.topValues ?? [];
    return tag.uniqueValues === 1 && values.length === 1 && values[0].value === String(classId);
  }

  async deleteIssues(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += ISSUE_DELETE_BATCH) {
      const batch = ids.slice(i, i + ISSUE_DELETE_BATCH);
      const res = await this.request(
        "delete_feedback",
        "DELETE",
        `/organizations/${encodeURIComponent(this.cfg.org)}/issues/`,
        [["project", "-1"], ...batch.map((id): [string, string] => ["id", id])]
      );
      await res.body?.cancel();
    }
  }

  async listReplays(projectId: string, classId: number) {
    return await this.listAll<{ id: string; classIds: unknown }>(
      "list_replays",
      `/organizations/${encodeURIComponent(this.cfg.org)}/replays/`,
      [
        ["project", projectId],
        ...this.scopeParams(),
        ["query", `class_id:"${classId}"`],
        ["field", "id"],
        ["field", "tags"],
        ["per_page", String(PAGE_SIZE)]
      ],
      (body) => {
        const data = (body as { data?: { id: string; tags?: Record<string, unknown> }[] })?.data;
        return Array.isArray(data) ? data.map((r) => ({ id: String(r.id), classIds: r.tags?.class_id })) : [];
      }
    );
  }

  async deleteReplay(replayId: string): Promise<void> {
    const res = await this.request(
      "delete_replay",
      "DELETE",
      `/projects/${encodeURIComponent(this.cfg.org)}/${encodeURIComponent(this.cfg.replayProject)}/replays/${encodeURIComponent(replayId)}/`
    );
    await res.body?.cancel();
  }
}

/** A replay's tags hold arrays of values; every one must be the class id. */
function replayTagMatches(classIds: unknown, classId: number): boolean {
  const values = Array.isArray(classIds) ? classIds : typeof classIds === "string" ? [classIds] : [];
  return values.length > 0 && values.every((v) => v === String(classId));
}

export type ClassPurgeResult = {
  feedbackDeleted: number;
  replaysDeleted: number;
  skippedTagMismatch: number;
  /**
   * Why the class stopped short, or null when both lists were complete and every listed item was
   * handled. A class that stopped is left unrecorded and picked up again next run; what it deleted
   * is still counted. `page_cap`: a list hit MAX_PAGES (the deleted items drop out of the next
   * run's list, so each run gets further).
   */
  stopped: "page_cap" | null;
};

export function emptyClassResult(): ClassPurgeResult {
  return { feedbackDeleted: 0, replaysDeleted: 0, skippedTagMismatch: 0, stopped: null };
}

/**
 * Deletes one class's feedback and replays, counting into `result` as it goes (so a caller that
 * catches an error mid-class still knows what was deleted). When a list hits the page cap, the
 * items it did list are still deleted and `stopped` says so.
 */
export async function purgeClass(
  api: SentryPurgeApi,
  replayProjectId: string,
  classId: number,
  result: ClassPurgeResult = emptyClassResult()
): Promise<ClassPurgeResult> {
  const issues = await api.listFeedbackIssues(classId);
  if (!issues.complete) result.stopped = "page_cap";
  let pending: string[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    await api.deleteIssues(pending);
    result.feedbackDeleted += pending.length;
    pending = [];
  };
  for (const issue of issues.items) {
    if (issue.category !== "feedback") {
      result.skippedTagMismatch++;
      continue;
    }
    if (await api.feedbackTagMatches(issue.id, classId)) {
      pending.push(issue.id);
      if (pending.length >= ISSUE_DELETE_BATCH) await flush();
    } else result.skippedTagMismatch++;
  }
  await flush();

  const replays = await api.listReplays(replayProjectId, classId);
  if (!replays.complete) result.stopped = "page_cap";
  for (const replay of replays.items) {
    if (!replayTagMatches(replay.classIds, classId)) {
      result.skippedTagMismatch++;
      continue;
    }
    await api.deleteReplay(replay.id);
    result.replaysDeleted++;
  }

  return result;
}

export type PurgeRunSummary = {
  classes_considered: number;
  classes_purged: number;
  classes_failed: number;
  /** Not started (time budget or a fatal error) or stopped at the page cap; retried next run. */
  classes_deferred: number;
  /** Deferred classes that had reports deleted before they stopped (counted in the totals below). */
  classes_partial: number;
  /** Returned by the candidate query but not past retention by this file's own check. */
  classes_not_due: number;
  feedback_deleted: number;
  replays_deleted: number;
  skipped_tag_mismatch: number;
  /** Step and HTTP status of the error that stopped the run, if one did. */
  stopped_by: string | null;
};

export type PurgeRunDeps = {
  api: SentryPurgeApi;
  candidates: PurgeCandidate[];
  /** Persists a finished class, so the next run knows when it was last swept. */
  recordPurged: (classId: number, result: ClassPurgeResult) => Promise<void>;
  now?: () => Date;
  /** Stop starting classes after this many ms, so the function returns inside the runtime's wall clock. */
  timeBudgetMs?: number;
};

export async function runPurge(deps: PurgeRunDeps): Promise<PurgeRunSummary> {
  const now = deps.now ?? (() => new Date());
  const started = now().getTime();
  const budget = deps.timeBudgetMs ?? 100_000;
  const summary: PurgeRunSummary = {
    classes_considered: deps.candidates.length,
    classes_purged: 0,
    classes_failed: 0,
    classes_deferred: 0,
    classes_partial: 0,
    classes_not_due: 0,
    feedback_deleted: 0,
    replays_deleted: 0,
    skipped_tag_mismatch: 0,
    stopped_by: null
  };

  const due = deps.candidates.filter((c) => isPastRetention(c.end_date, now()));
  summary.classes_not_due = deps.candidates.length - due.length;
  if (due.length === 0) return summary;

  let projectId: string;
  try {
    projectId = await deps.api.replayProjectId();
  } catch (e) {
    summary.classes_deferred = due.length;
    summary.stopped_by = describe(e);
    return summary;
  }

  for (let i = 0; i < due.length; i++) {
    if (now().getTime() - started > budget) {
      summary.classes_deferred += due.length - i;
      break;
    }
    const c = due[i];
    const result = emptyClassResult();
    try {
      await purgeClass(deps.api, projectId, c.class_id, result);
      if (result.stopped !== null) {
        summary.classes_deferred++;
        if (result.feedbackDeleted + result.replaysDeleted > 0) summary.classes_partial++;
        continue;
      }
      await deps.recordPurged(c.class_id, result);
      summary.classes_purged++;
    } catch (e) {
      summary.classes_failed++;
      if (e instanceof SentryApiError && e.fatal) {
        summary.stopped_by = describe(e);
        summary.classes_deferred += due.length - i - 1;
        break;
      }
      console.error(`[bug-report-retention-purge] class failed: ${describe(e)}`);
    } finally {
      // Deleted is deleted, whether the class finished, stopped short or failed partway.
      summary.feedback_deleted += result.feedbackDeleted;
      summary.replays_deleted += result.replaysDeleted;
      summary.skipped_tag_mismatch += result.skippedTagMismatch;
    }
  }
  return summary;
}

function describe(e: unknown): string {
  if (e instanceof SentryApiError) return `${e.step}:${e.status ?? "network"}`;
  return e instanceof Error ? e.name : "unknown";
}
