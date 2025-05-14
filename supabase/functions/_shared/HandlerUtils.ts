import { GetResult } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/result.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { RepositoryCheckRun } from "./FunctionTypes.d.ts";
import { Database } from "./SupabaseTypes.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
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

type RepositoryWithAssignmentAndAutograder = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*, assignments(submission_files, class_id, autograders(*))"
>;
export async function userCanCreateSubmission({
  checkRun,
  repoData,
  adminSupabase
}: {
  checkRun: RepositoryCheckRun;
  repoData: RepositoryWithAssignmentAndAutograder;
  adminSupabase: SupabaseClient<Database>;
}) {
  //If the check run was created by a grader or instructor, then we can always create a submission
  if (checkRun.status.created_by && checkRun.status.created_by !== "github") {
    const { data: profile, error: profileError } = await adminSupabase
      .from("user_roles")
      .select("*")
      .eq("private_profile_id", checkRun.status.created_by)
      .eq("class_id", checkRun.class_id)
      .maybeSingle();
    if (profileError) {
      throw new UserVisibleError(`Failed to find profile: ${profileError.message}`);
    }
    if (profile?.role === "instructor" || profile?.role === "grader") {
      return true;
    }
  }
  //Check due date vs late date

  const { data: submission, error: submissionError } = await adminSupabase
    .from("submissions")
    .select("*")
    .eq("repository_id", checkRun.repository_id)
    .eq("sha", checkRun.sha)
    .maybeSingle();
  if (submissionError) {
    throw new UserVisibleError(`Failed to find submission: ${submissionError.message}`);
  }
}
export async function wrapRequestHandler(req: Request, handler: (req: Request) => Promise<any>) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    let data = await handler(req);
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
    super("Error");
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
    super("Not Found");
    this.details = details;
  }
}
