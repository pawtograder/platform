import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as canvas from "../_shared/CanvasWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { assertUserIsInstructor } from "../_shared/HandlerUtils.ts";
import { createUserInClass } from "../_shared/EnrollmentUtils.ts";
async function handleRequest(req: Request) {
  const courseId = Number.parseInt(req.url.split("/").pop()!);
  if (!courseId) {
    throw new UserVisibleError("Course ID is required");
  }
  await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: course } = await adminSupabase.from("classes").select("*").eq(
    "id",
    courseId,
  ).single();
  const canvasEnrollments = await canvas.getEnrollments(
    course!.canvas_id!,
  );
  const supabaseEnrollments = await adminSupabase.from("user_roles").select("*").eq(
    "class_id",
    courseId,
  );
  // Find the enrollments that need to be added
  const newEnrollments = canvasEnrollments.filter(canvasEnrollment => !supabaseEnrollments.data!.find(supabaseEnrollment => supabaseEnrollment.canvas_id === canvasEnrollment.id));
  // const newEnrollments = canvasEnrollments;
  const allUsers = await adminSupabase.auth.admin.listUsers();
  const newProfiles = await Promise.all(
    newEnrollments.map(async (enrollment) => {
      const user = await canvas.getUser(enrollment.user_id);
      // Does the user already exist in supabase?
      const existingUser = allUsers.data!.users.find((dbUser) =>
        user.primary_email === dbUser.email
      );
      const dbRoleForCanvasRole = (
        role: string,
      ): Database["public"]["Enums"]["app_role"] => {
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
      await createUserInClass(adminSupabase, courseId, {
        existing_user_id: existingUser?.id,
        canvas_id: enrollment.id,
        canvas_course_id: enrollment.course_id,
        ...user,
      }, dbRoleForCanvasRole(enrollment.role));
    }),
  );
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
