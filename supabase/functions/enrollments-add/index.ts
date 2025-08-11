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
    throw new UserVisibleError("Course ID is required");
  }
  scope?.setTag("function", "enrollments-add");
  scope?.setTag("email", email);
  scope?.setTag("name", name);
  scope?.setTag("role", role);
  scope?.setTag("courseId", courseId.toString());
  //Validate that the user is an instructor for this course
  await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
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

    if (resolvedUser?.id) {
      // Create a simple email entry which will be converted into a notification via trigger
      const subject = "You were added to a course";
      const body =
        "You have been added to a course on Pawtograder. Please sign in to view details.";

      await adminSupabase
        .from("email_batches")
        .insert({
          class_id: courseId,
          subject,
          body,
          cc_emails: { emails: [] },
          reply_to: Deno.env.get("SMTP_REPLY_TO") || null
        })
        .select("id")
        .single()
        .then(async ({ data: batch }) => {
          if (batch?.id) {
            await adminSupabase.from("emails").insert({
              user_id: resolvedUser.id,
              class_id: courseId,
              batch_id: batch.id,
              subject,
              body,
              cc_emails: { emails: [] },
              reply_to: Deno.env.get("SMTP_REPLY_TO") || null
            });
          }
        });
    }
  }
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
