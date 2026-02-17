import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as canvas from "../_shared/CanvasWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { assertUserIsInstructor } from "../_shared/HandlerUtils.ts";
import { createUserInClass } from "../_shared/EnrollmentUtils.ts";
import * as Sentry from "npm:@sentry/deno";
async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { course_id } = (await req.json()) as { course_id: number };
  if (!course_id) {
    throw new UserVisibleError("Course ID is required", 400);
  }
  scope?.setTag("function", "enrollments-sync-canvas");
  scope?.setTag("course_id", course_id.toString());
  await assertUserIsInstructor(course_id, req.headers.get("Authorization")!);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: course } = await adminSupabase
    .from("classes")
    .select("*, class_sections(*)")
    .eq("id", course_id)
    .single();
  const canvasEnrollments = (
    await Promise.all(
      course!.class_sections.map((section) => {
        return canvas.getEnrollments(section, scope);
      })
    )
  ).flat();
  const supabaseEnrollments = await adminSupabase
    .from("user_roles")
    .select("*, profiles!private_profile_id(name, sortable_name, avatar_url)")
    .eq("class_id", course_id);
  // Find the enrollments that need to be added
  const newEnrollments = canvasEnrollments.filter(
    (canvasEnrollment) =>
      !supabaseEnrollments.data!.find((supabaseEnrollment) => supabaseEnrollment.canvas_id === canvasEnrollment.user.id)
  );

  scope?.setTag("canvas_enrollments_count", canvasEnrollments.length.toString());
  scope?.setTag("supabase_enrollments_count", supabaseEnrollments.data?.length.toString() || "0");
  scope?.setTag("new_enrollments_count", newEnrollments.length.toString());
  const allUsers = await adminSupabase.auth.admin.listUsers({
    perPage: 10000
  });
  scope?.setTag("supabase_users_length", allUsers.data!.users.length.toString());
  const failureMessages: string[] = [];
  await Promise.all(
    newEnrollments.map(async (enrollment) => {
      if (enrollment.user.name === "Test Student") {
        return; //Wow I hope that nobody actually has a student named Test Student, great job, Canvas!
      }
      try {
        const user = await canvas.getUser(course_id, enrollment.user.id, scope);
        // Does the user already exist in supabase?
        const existingUser = allUsers.data!.users.find((dbUser) => user.primary_email === dbUser.email);
        const dbRoleForCanvasRole = (role: string): Database["public"]["Enums"]["app_role"] => {
          switch (role) {
            case "StudentEnrollment":
              return "student";
            case "TeacherEnrollment":
              return "instructor";
            case "TaEnrollment":
              return "grader";
            case "ObserverEnrollment":
              return "student";
            default:
              return "student";
          }
        };
        const classSection = course!.class_sections.find(
          (section) => section.canvas_course_section_id === enrollment.course_section_id
        );
        await createUserInClass(
          adminSupabase,
          course_id,
          {
            existing_user_id: existingUser?.id,
            canvas_id: enrollment.user.id,
            canvas_course_id: enrollment.course_id,
            canvas_section_id: enrollment.course_section_id,
            class_section_id: classSection?.id,
            ...user
          },
          dbRoleForCanvasRole(enrollment.role)
        );
      } catch (e) {
        if ((e as { response?: { statusCode?: number } })?.response?.statusCode === 403) {
          console.log(
            `Unable to create account for user ${enrollment.user.name} (${enrollment.user.id}), Canvas refuses to give us their email.`
          );
          failureMessages.push(
            `Unable to create account for user ${enrollment.user.name} (${enrollment.user.id}), Canvas refuses to give us their email.`
          );
        } else {
          console.error(JSON.stringify(e, null, 2));
          throw new UserVisibleError(`Error creating user for enrollment ${JSON.stringify(enrollment)}: ${e}`);
        }
      }
    })
  );
  const removedProfiles = supabaseEnrollments.data!.filter(
    (enrollment) =>
      enrollment.canvas_id &&
      !canvasEnrollments.find((canvasEnrollment) => canvasEnrollment.user.id === enrollment.canvas_id)
  );

  scope?.setTag("removed_profiles_count", removedProfiles.length.toString());
  scope?.setTag("failure_messages_count", failureMessages.length.toString());
  await Promise.all(
    removedProfiles.map(async (enrollment) => {
      await adminSupabase.from("user_roles").delete().eq("id", enrollment.id);
      console.log("WARN: Removing enrollment for user", enrollment.canvas_id, "from class", course_id);
    })
  );
  //Check names, avatars etc.
  await Promise.all(
    supabaseEnrollments.data!.map(async (enrollment) => {
      const user = canvasEnrollments.find((canvasEnrollment) => canvasEnrollment.user.id === enrollment.canvas_id);
      if (user && user.user.name !== enrollment.profiles.name) {
        await adminSupabase
          .from("profiles")
          .update({
            name: user.user.name,
            sortable_name: user.user.sortable_name
          })
          .eq("id", enrollment.private_profile_id);
      }
    })
  );
  if (failureMessages.length > 0) {
    throw new UserVisibleError(`Enrollments synced, however there were errors:\n` + failureMessages.join("\n"));
  }
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
