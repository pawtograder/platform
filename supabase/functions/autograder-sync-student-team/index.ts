import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3/dist/module/index.js";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { reinviteToOrgTeam, syncStudentTeam } from "../_shared/GitHubWrapper.ts";
import {
  assertUserIsInstructor,
  UserVisibleError,
  wrapRequestHandler,
  fetchAllPages
} from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

//See also autograder-sync-staff-team
async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-sync-student-team");
  const secret = req.headers.get("x-edge-function-secret");
  if (secret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("course_id")!);
    scope?.setTag("course_id", course_id.toString());

    const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
    if (secret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Invalid secret" }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: classData, error: classError } = await adminSupabase
      .from("classes")
      .select("slug, github_org")
      .eq("id", course_id)
      .single();
    if (classError) {
      throw new UserVisibleError("Error fetching class");
    }
    if (!classData) {
      throw new UserVisibleError("No class found for course");
    }
    scope?.setTag("github_org", classData.github_org!);
    scope?.setTag("slug", classData.slug!);
    //Find any students who never got an invitatino
    const { data: usersWithoutInvitation, error: usersWithoutInvitationError } = await adminSupabase
      .from("user_roles")
      .select("user_id, invitation_date, users(github_username)")
      .eq("class_id", course_id)
      .eq("role", "student")
      .is("invitation_date", null)
      .not("users!inner(github_username)", "is", null)
      .limit(1000);
    if (usersWithoutInvitationError) {
      console.error(usersWithoutInvitationError);
      throw new UserVisibleError("Error fetching students");
    }
    for (const user of usersWithoutInvitation!) {
      if (user.users.github_username) {
        console.log(`User ${user.users.github_username} has no invitation, invitation date: ${user.invitation_date}`);
        try {
          const resp = await reinviteToOrgTeam(
            classData.github_org!,
            classData.slug! + "-students",
            user.users.github_username!
          );
          if (!resp) {
            await adminSupabase
              .from("user_roles")
              .update({
                github_org_confirmed: true
              })
              .eq("user_id", user.user_id)
              .eq("class_id", course_id);
          }
        } catch (error) {
          const newScope = new Sentry.Scope();
          newScope.setTag("user_id", user.user_id);
          newScope.setTag("github_username", user.users.github_username!);
          Sentry.captureException(error, newScope);
          console.error(error);
        }
      }
    }

    await syncStudentTeam(
      classData.github_org!,
      classData.slug!,
      async () => {
        const { data: students, error: studentsError } = await adminSupabase
          .from("user_roles")
          .select("github_org_confirmed, users(github_username)")
          .eq("class_id", course_id)
          .or("role.eq.student")
          .limit(1000);
        if (studentsError) {
          console.error(studentsError);
          throw new UserVisibleError("Error fetching students");
        }
        return students!
          .filter((s) => s.users.github_username && s.github_org_confirmed)
          .map((s) => s.users.github_username!);
      },
      scope
    );
  } else {
    const { course_id } = (await req.json()) as { course_id: number };
    scope?.setTag("course_id", course_id.toString());
    const { supabase } = await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
    const { data: classData, error: classError } = await supabase
      .from("classes")
      .select("slug, github_org")
      .eq("id", course_id)
      .single();
    if (classError) {
      throw new UserVisibleError("Error fetching class");
    }
    if (!classData) {
      throw new UserVisibleError("No class found for course");
    }
    scope?.setTag("github_org", classData.github_org!);
    scope?.setTag("slug", classData.slug!);
    await syncStudentTeam(
      classData.github_org!,
      classData.slug!,
      async () => {
        const { data: students, error: studentsError } = await supabase
          .from("user_roles")
          .select("github_org_confirmed, users(github_username)")
          .eq("class_id", course_id)
          .or("role.eq.student")
          .limit(1000);
        if (studentsError) {
          console.error(studentsError);
          throw new UserVisibleError("Error fetching students");
        }
        return students!
          .filter((s) => s.users.github_username && s.github_org_confirmed)
          .map((s) => s.users.github_username!);
      },
      scope
    );
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
