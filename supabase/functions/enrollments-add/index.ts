import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { createUserInClass } from "../_shared/EnrollmentUtils.ts";
import type { AddEnrollmentRequest } from "../_shared/FunctionTypes.d.ts";
import {
  assertRoleLookupSucceeded,
  assertUserHasCapabilityOrServiceRole,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { email, name, role, courseId, notify } = (await req.json()) as AddEnrollmentRequest;
  if (!courseId) {
    throw new UserVisibleError("Course ID is required", 400);
  }
  // This writes user_roles through the service-role client, which guard_admin_role_grant trusts,
  // so the role has to be checked here. An admin row in any class is platform-wide admin.
  if (!["student", "grader", "instructor"].includes(role)) {
    throw new UserVisibleError("Valid role is required (student, grader, or instructor)", 400);
  }
  scope?.setTag("function", "enrollments-add");
  // No email or name tags: Sentry events never carry a person's name or email. `role` is the
  // caller's role (set below); the role being granted is `enrollment_role`.
  scope?.setTag("enrollment_role", role);
  scope?.setTag("courseId", courseId.toString());
  // Adding someone needs manage_roster (#1010). Instructors and platform admins can add any role;
  // anyone else with manage_roster, such as a Head TA, can add students only.
  const authHeader = req.headers.get("Authorization");
  const { supabase: callerSupabase, isServiceRole } = await assertUserHasCapabilityOrServiceRole(
    courseId,
    "manage_roster",
    authHeader
  );
  let callerUserId: string | undefined;
  let callerRole = "service_role";
  let canAddAnyRole = isServiceRole;
  if (!isServiceRole) {
    const {
      data: { user },
      error: userError
    } = await callerSupabase.auth.getUser(authHeader!.replace("Bearer ", ""));
    if (userError || !user) {
      throw new SecurityError("User not found");
    }
    callerUserId = user.id;
    const { data: callerRoles, error: callerRolesError } = await callerSupabase
      .from("user_roles")
      .select("role, class_id")
      .eq("user_id", user.id);
    assertRoleLookupSucceeded(callerRolesError, "Role lookup");
    const isAdmin = (callerRoles ?? []).some((r) => r.role === "admin");
    const roleInCourse = (callerRoles ?? []).find((r) => r.class_id === Number(courseId))?.role;
    callerRole = isAdmin ? "admin" : (roleInCourse ?? "none");
    canAddAnyRole = isAdmin || roleInCourse === "instructor";
  }
  if (!canAddAnyRole && role !== "student") {
    throw new UserVisibleError("Only an instructor can add graders or instructors", 403);
  }
  // The caller by ID, and their actual role in the course (or admin).
  if (callerUserId) {
    scope?.setUser({ id: callerUserId });
  }
  scope?.setTag("role", callerRole);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );
  const { data: existingUser } = await adminSupabase
    .rpc("get_user_id_by_email", {
      email: email
    })
    .single();
  if (!canAddAnyRole && existingUser?.id) {
    // createUserInClass would rename an existing person's profile, and their row may be a grader's
    // or an instructor's. Only an instructor can change an enrollment that already exists.
    const { data: existingRoles, error: existingRolesError } = await adminSupabase
      .from("user_roles")
      .select("id")
      .eq("user_id", existingUser.id)
      .eq("class_id", courseId);
    assertRoleLookupSucceeded(existingRolesError, "Enrollment lookup");
    if ((existingRoles ?? []).length > 0) {
      throw new UserVisibleError(
        "This person is already in the course. Only an instructor can change an existing enrollment.",
        403
      );
    }
  }
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

    if (callerUserId) {
      const { data: inviterData } = await adminSupabase
        .from("users")
        .select("email")
        .eq("user_id", callerUserId)
        .single();

      const { data: inviterProfile } = await adminSupabase
        .from("user_roles")
        .select("profiles!private_profile_id(name)")
        .eq("user_id", callerUserId)
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
