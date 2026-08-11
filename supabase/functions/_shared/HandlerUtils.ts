import { PostgrestFilterBuilder } from "https://esm.sh/@supabase/postgrest-js@1.19.2";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "./SupabaseTypes.d.ts";
// Import for side effect. Module evaluation order guarantees this runs to completion before any
// code in this file, so the ~50 functions that rely on importing HandlerUtils to get Sentry keep
// exactly the behavior they had when the init lived here.
import "./SentryInit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// --- Per-function log tagging -------------------------------------------------
// All ~49 functions share one pod's stdout behind the demuxer (main.ts), so logs
// aren't filterable BY function unless each line carries the function name. The
// demuxer passes the name to each worker as the EDGE_FUNCTION_NAME env var; here
// we prefix this isolate's console output with `[fn=<name>]` so
// `{component="functions"} |= "[fn=<name>]"` works in Loki/Grafana/
// `scripts/edge-logs.sh`. Done once per isolate and safe: the edge-runtime
// creates each worker against a single function's servicePath, so the isolate
// only ever serves that one function — the name is constant for its lifetime.
// Exported so the few functions that don't use wrapRequestHandler can call it
// at entry too.
let fnLogContextInstalled = false;
export function installFunctionLogContext(): string | null {
  const fn = Deno.env.get("EDGE_FUNCTION_NAME") ?? null;
  if (fnLogContextInstalled || !fn) return fn;
  fnLogContextInstalled = true;
  const prefix = `[fn=${fn}]`;
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    const orig = c[m]?.bind(console);
    if (!orig) continue;
    c[m] = (...args: unknown[]) => orig(prefix, ...args);
  }
  return fn;
}

/**
 * Add comprehensive database operation tags to Sentry scope
 */
export function tagDatabaseOperation(
  scope: Sentry.Scope,
  operation: string,
  table: string,
  filters?: Record<string, string | number | boolean>
) {
  scope?.setTag("db_operation", operation);
  scope?.setTag("db_table", table);
  if (filters) {
    Object.entries(filters).forEach(([key, value]) => {
      scope?.setTag(`db_filter_${key}`, String(value));
    });
  }
}

/**
 * Add user context tags to Sentry scope
 */
export function tagUserContext(scope: Sentry.Scope, userId: string, role?: string, courseId?: number) {
  scope?.setTag("user_id", userId);
  if (role) scope?.setTag("user_role", role);
  if (courseId) scope?.setTag("course_id", courseId.toString());
}

/**
 * Add API call tags to Sentry scope
 */
export function tagApiCall(
  scope: Sentry.Scope,
  service: "github" | "canvas" | "chime" | "supabase",
  operation: string,
  resource?: string
) {
  scope?.setTag("api_service", service);
  scope?.setTag("api_operation", operation);
  if (resource) scope?.setTag("api_resource", resource);
}
/**
 * Check if the request is authenticated with the service role key.
 * This allows scripts and internal services to call edge functions without user context.
 */
export function isServiceRoleRequest(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return token === serviceRoleKey;
}

export async function assertUserIsInstructor(courseId: number, authHeader: string) {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error) {
    console.error(error);
  }
  assertAuthLookupSucceeded(error);
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .eq("role", "instructor")
    .maybeSingle();
  // maybeSingle, so an absent row is `null` with no error and any error is a real failure.
  assertRoleLookupSucceeded(enrollmentError, "Role lookup");
  if (!enrollment) {
    //OK if user is an ADMIN of any course
    const { data: adminEnrollment, error: adminError } = await supabase
      .from("user_roles")
      .select("*")
      .eq("user_id", user.id)
      .eq("role", "admin");
    // Denying instructor access because the admin fallback query failed would be the same mistake.
    assertRoleLookupSucceeded(adminError, "Role lookup");
    if (adminEnrollment && adminEnrollment.length > 0) {
      return { supabase, enrollment: adminEnrollment[0] };
    }
    throw new SecurityError("User is not an instructor for this course");
  }
  return { supabase, enrollment };
}

/**
 * Assert that the user is an instructor OR the request is from service role.
 * Use this for functions that need to be callable both by instructors in the UI
 * and by admin scripts using the service role key.
 */
export async function assertUserIsInstructorOrServiceRole(courseId: number, authHeader: string | null) {
  if (!authHeader) {
    throw new SecurityError("Authorization header required");
  }

  // Allow service role requests (for scripts and internal services)
  if (isServiceRoleRequest(authHeader)) {
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    return { supabase: adminSupabase, enrollment: null, isServiceRole: true };
  }

  // Otherwise, check for instructor role
  const result = await assertUserIsInstructor(courseId, authHeader);
  return { ...result, isServiceRole: false };
}
/**
 * Distinguish "the authorization question was answered no" from "the authorization question could not
 * be asked".
 *
 * These assertions read the caller's roles over PostgREST and treated a missing row and a failed query
 * identically, so while Kong was returning 502s during e2e runs, enrolled students were told
 * `SecurityError` — 401, "not enrolled in this course". Nothing retries a 401, and the resulting Sentry
 * events are indistinguishable from the genuine denials that the negative-path tests produce, so the
 * failure hid inside expected noise.
 *
 * `.single()` reports "no unique row" as PGRST116, which IS the denial and must keep its current
 * status. Every other error — a 5xx, a transport failure, a schema problem — means we do not know the
 * answer, and saying so as a retryable 503 is both true and actionable.
 */
export function assertRoleLookupSucceeded(error: { code?: string; message: string } | null, operation: string): void {
  if (!error || error.code === "PGRST116") return;
  throw new UserVisibleError(`${operation} is temporarily unavailable: ${error.message}`, 503);
}

/**
 * Same, for the auth server. Only an explicit 4xx is a statement about the token.
 *
 * Note the range check rather than `< 500`: `@supabase/auth-js` reports a transport failure (DNS,
 * connection refused, CORS) as an `AuthRetryableFetchError` carrying `status: 0`, so a naive "below
 * 500 means the auth server answered" test would classify exactly the outage this guard exists to
 * catch as a 401. Anything that is not a 4xx — 0, absent, 3xx, 5xx — means we never got an answer.
 */
export function assertAuthLookupSucceeded(error: { status?: number; message: string } | null | undefined): void {
  if (!error) return;
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return;
  throw new UserVisibleError(`Authentication is temporarily unavailable: ${error.message}`, 503);
}

/**
 * Assert that the caller is a platform admin (has an `admin` role in any class),
 * or is the service role. Use for admin-only functions that are not scoped to a
 * single course (e.g. listing GitHub App installations for the create-class form).
 */
export async function assertUserIsAdmin(authHeader: string | null) {
  if (!authHeader) {
    throw new SecurityError("Authorization header required");
  }
  if (isServiceRoleRequest(authHeader)) {
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    return { supabase: adminSupabase, isServiceRole: true as const };
  }
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  assertAuthLookupSucceeded(userError);
  const user = userData?.user;
  if (!user) {
    throw new SecurityError("User not found");
  }
  // Mirror authorize_for_admin(): a disabled admin role must not authorize.
  const { data: adminEnrollment, error: adminError } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .eq("disabled", false)
    .limit(1);
  // No `.single()` here, so an empty result is `[]` and any error at all is a real failure.
  assertRoleLookupSucceeded(adminError, "Role lookup");
  if (!adminEnrollment || adminEnrollment.length === 0) {
    throw new SecurityError("User is not an admin");
  }
  return { supabase, isServiceRole: false as const };
}
export async function assertUserIsInstructorOrGrader(courseId: number, authHeader: string) {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error
  } = await supabase.auth.getUser(token);
  if (error) {
    console.error(error);
  }
  assertAuthLookupSucceeded(error);
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .in("role", ["instructor", "grader"])
    .single();
  assertRoleLookupSucceeded(enrollmentError, "Role lookup");
  if (!enrollment) {
    throw new SecurityError("User is not an instructor or grader for this course");
  }
  return { supabase, enrollment };
}
export async function assertUserIsInCourse(courseId: number, authHeader: string) {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: authHeader }
    }
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  assertAuthLookupSucceeded(userError);
  const user = userData?.user;
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment, error: enrollmentError } = await supabase
    .from("user_roles")
    .select("*, classes(*)")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .single();
  assertRoleLookupSucceeded(enrollmentError, "Enrollment lookup");
  if (!enrollment) {
    throw new SecurityError("User is not enrolled in this course");
  }
  return { supabase, enrollment };
}

export async function wrapRequestHandler(
  req: Request,
  handler: (req: Request, scope: Sentry.Scope) => Promise<unknown>,
  {
    recordUserVisibleErrors,
    recordSecurityErrors
  }:
    | {
        recordUserVisibleErrors?: boolean;
        recordSecurityErrors?: boolean;
      }
    | undefined = { recordUserVisibleErrors: true, recordSecurityErrors: true }
) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const functionName = installFunctionLogContext();
  const scope = new Sentry.Scope();
  if (functionName) scope.setTag("function", functionName);
  scope.setTag("URL", req.url);
  scope.setTag("Method", req.method);
  try {
    let data = await handler(req, scope);
    if (!data) {
      data = {};
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (e) {
    console.error(e);
    if (e instanceof UserVisibleError) {
      if (recordUserVisibleErrors) {
        Sentry.captureException(e, scope);
      }
    } else if (e instanceof SecurityError) {
      if (recordSecurityErrors) {
        Sentry.captureException(e, scope);
      }
    } else if (!(e instanceof NotFoundError) && !(e instanceof IllegalArgumentError)) {
      // Generic/unexpected server fault — capture it. Expected client-facing
      // conditions (NotFoundError → 404, IllegalArgumentError → 400) have their own
      // clean responses below and must NOT page us via Sentry. Previously they fell
      // into this branch and were captured — e.g. every read of a repo whose org
      // hasn't installed the GitHub App (common in e2e against synthetic orgs)
      // produced a noisy error event.
      Sentry.captureException(e, scope);
    }
    const genericErrorHeaders = {
      "Content-Type": "application/json",
      ...corsHeaders
    };
    if (e instanceof SecurityError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: false,
            message: e.details,
            details: e.details
          }
        }),
        {
          headers: genericErrorHeaders,
          status: e.status
        }
      );
    }
    if (e instanceof UserVisibleError) {
      // Surface the actual message to clients; the previous "Internal Server Error" title
      // was shown in UIs that only display `error.message`, hiding `details`.
      return new Response(
        JSON.stringify({
          error: {
            recoverable: e.status >= 500,
            message: e.details,
            details: e.details
          }
        }),
        {
          headers: genericErrorHeaders,
          status: e.status
        }
      );
    }
    if (e instanceof NotFoundError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: false,
            message: "Not Found",
            // Surface the thrower's actionable detail when present (e.g. the
            // "install the GitHub App on <org>" guidance) instead of swallowing
            // it; fall back to the generic message otherwise.
            details: e.details || "The requested resource was not found"
          }
        }),
        {
          headers: genericErrorHeaders,
          status: e.status
        }
      );
    }
    if (e instanceof IllegalArgumentError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: true,
            message: e.details,
            details: e.details
          }
        }),
        {
          headers: genericErrorHeaders,
          status: e.status
        }
      );
    }
    return new Response(
      JSON.stringify({
        error: {
          recoverable: true,
          message: "Internal Server Error",
          details: "An unknown error occurred"
        }
      }),
      {
        headers: genericErrorHeaders,
        // Every typed branch above sets a status; this catch-all did not, and Response defaults to
        // 200. So an unclassified throw — a TypeError, an OOM, anything not one of our error types —
        // was reported to the caller as a SUCCESSFUL request with an error object in the body.
        // Latent in most functions, since only a caller that inspects the body would notice.
        status: 500
      }
    );
  }
}
export class SecurityError extends Error {
  details: string;
  status: number = 401;
  constructor(details: string) {
    super("Security Error");
    this.details = details;
  }
}

export class UserVisibleError extends Error {
  details: string;
  status: number;
  constructor(details: string, status: number = 500) {
    super(details);
    this.details = details;
    this.status = status;
  }
}

export class IllegalArgumentError extends Error {
  details: string;
  status: number = 400;
  constructor(details: string) {
    super("Illegal Argument");
    this.details = details;
  }
}
export class NotFoundError extends Error {
  details: string;
  status: number = 404;
  constructor(details: string) {
    super(details);
    this.details = details;
  }
}

type FetchAllPagesResult<T> = { data: NonNullable<T[]>; error: null } | { data: null; error: NonNullable<unknown> };

/**
 * Helper function to fetch all pages of a Supabase query result.
 * Handles pagination automatically and returns all results combined.
 *
 * Invariant: If error is null, data is guaranteed to be a valid T[] array (never null)
 *
 * @param queryBuilder - Function that returns a Supabase query (without limit/offset)
 * @param pageSize - Number of records to fetch per page (default: 1000)
 * @returns Promise<FetchAllPagesResult<T>> - All results or error
 *
 * @example
 * ```typescript
 * const { data: allStudents, error } = await fetchAllPages(() =>
 *   supabase
 *     .from("user_roles")
 *     .select("users(github_username)")
 *     .eq("class_id", course_id)
 *     .or("role.eq.student")
 * );
 * if (error) {
 *   console.error(error);
 *   return;
 * }
 * // allStudents is guaranteed to be T[] here (never null)
 * ```
 */
export async function fetchAllPages<T>(
  query: PostgrestFilterBuilder<
    Database["public"],
    Database["public"]["Tables"]["user_roles"]["Row"],
    Database["public"]["Tables"]["user_roles"]["Row"][]
  >,
  pageSize: number = 1000
): Promise<FetchAllPagesResult<T>> {
  try {
    const allResults: T[] = [];
    let offset = 0;
    let hasMoreData = true;

    while (hasMoreData) {
      const { data, error } = await query.range(offset, offset + pageSize - 1);

      if (error || !data) {
        return { data: null, error: error as NonNullable<unknown> };
      }

      // Handle the case where data is null but no error occurred
      if (data === null) {
        // This shouldn't happen with Supabase, but handle it defensively
        hasMoreData = false;
      } else if (Array.isArray(data) && data.length > 0) {
        // @ts-expect-error Types are weird and sometimes it doesn't know that data is T[]
        allResults.push(...data);

        // If we got less than the page size, we've reached the end
        if (data.length < pageSize) {
          hasMoreData = false;
        } else {
          offset += pageSize;
        }
      } else {
        // data is an empty array, no more pages
        hasMoreData = false;
      }
    }

    return { data: allResults, error: null };
  } catch (error) {
    return { data: null, error: error as NonNullable<unknown> };
  }
}
