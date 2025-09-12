import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { createUserInClass } from "../_shared/EnrollmentUtils.ts";
import type { AddEnrollmentRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { email, name, role, courseId, notify } = (await req.json()) as AddEnrollmentRequest;
  if (!courseId) {
    throw new UserVisibleError("Course ID is required", 400);
  }
  scope?.setTag("function", "enrollments-add");
  scope?.setTag("email", email);
  scope?.setTag("name", name);
  scope?.setTag("role", role);
  scope?.setTag("courseId", courseId.toString());
  //Validate that the user is an instructor for this course
  const { enrollment: instructorEnrollment } = await assertUserIsInstructor(
    courseId,
    req.headers.get("Authorization")!
  );
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: existingUser } = await adminSupabase
    .rpc("get_user_id_by_email", {
      email: email
    })
    .single();
  await createUserInClass(
    adminSupabase,
    courseId,
    {
      primary_email: email,
      name: name,
      existing_user_id: existingUser?.id
    },
    role
  );

  if (notify) {
    // Resolve the user's ID (existing or newly created)
    const { data: resolvedUser } = await adminSupabase
      .rpc("get_user_id_by_email", {
        email: email
      })
      .single();

    // Get course details
    const { data: courseData } = await adminSupabase.from("classes").select("name").eq("id", courseId).single();

    // Get inviter details from JWT
    let inviterName = "Course Administrator";
    let inviterEmail = "";

    if (instructorEnrollment?.user_id) {
      const { data: inviterData } = await adminSupabase
        .from("users")
        .select("email")
        .eq("user_id", instructorEnrollment.user_id)
        .single();

      const { data: inviterProfile } = await adminSupabase
        .from("user_roles")
        .select("profiles!private_profile_id(name)")
        .eq("user_id", instructorEnrollment.user_id)
        .eq("class_id", courseId)
        .single();

      if (inviterData?.email) {
        inviterEmail = inviterData.email;
      }
      if (inviterProfile?.profiles?.name) {
        inviterName = inviterProfile.profiles.name;
      }
    }

    if (resolvedUser?.id && courseData?.name) {
      // Create a course enrollment notification
      const notificationBody = {
        type: "course_enrollment",
        action: "create",
        course_name: courseData.name,
        course_id: courseId,
        inviter_name: inviterName,
        inviter_email: inviterEmail
      };

      await adminSupabase.from("notifications").insert({
        user_id: resolvedUser.id,
        class_id: courseId,
        subject: `You have been added to ${courseData.name}`,
        body: notificationBody,
        style: "info"
      });
    }
  }
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
