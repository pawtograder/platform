import { PostgrestFilterBuilder } from "https://esm.sh/@supabase/postgrest-js@1.19.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "./SupabaseTypes.d.ts";

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("SUPABASE_URL")!,
    sendDefaultPii: true,
    integrations: [],
    tracesSampleRate: 0
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

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
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .eq("role", "instructor")
    .single();
  if (!enrollment) {
    throw new SecurityError("User is not an instructor for this course");
  }
  return { supabase, enrollment };
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
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .in("role", ["instructor", "grader"])
    .single();
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
  const {
    data: { user }
  } = await supabase.auth.getUser(token);
  if (!user) {
    throw new SecurityError("User not found");
  }
  const { data: enrollment } = await supabase
    .from("user_roles")
    .select("*, classes(*)")
    .eq("user_id", user.id)
    .eq("class_id", courseId)
    .single();
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
  const scope = new Sentry.Scope();
  scope.setTag("URL", req.url);
  scope.setTag("Method", req.method);
  scope.setTag("Headers", JSON.stringify(Object.fromEntries(req.headers)));
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
    } else {
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
            message: "Security Error",
            details: "This request has been reported to the staff"
          }
        }),
        {
          headers: genericErrorHeaders
        }
      );
    }
    if (e instanceof UserVisibleError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: false,
            message: "Internal Server Error",
            details: e.details
          }
        }),
        {
          headers: genericErrorHeaders
        }
      );
    }
    if (e instanceof NotFoundError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: true,
            message: "Not Found",
            details: "The requested resource was not found"
          }
        }),
        {
          headers: genericErrorHeaders
        }
      );
    }
    if (e instanceof IllegalArgumentError) {
      return new Response(
        JSON.stringify({
          error: {
            recoverable: true,
            message: "Illegal Argument",
            details: e.details
          }
        }),
        {
          headers: genericErrorHeaders
        }
      );
    }
    return new Response(
      JSON.stringify({
        error: {
          recoverable: false,
          message: "Internal Server Error",
          details: "An unknown error occurred"
        }
      }),
      {
        headers: genericErrorHeaders
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
  status: number = 500;
  constructor(details: string) {
    super(details);
    this.details = details;
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
  query: PostgrestFilterBuilder<Database, T[], T>,
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
      } else if (data.length > 0) {
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
