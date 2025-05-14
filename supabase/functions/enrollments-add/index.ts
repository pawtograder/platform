import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { createUserInClass } from "../_shared/EnrollmentUtils.ts";
import type { AddEnrollmentRequest } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

async function handleRequest(req: Request) {
  const { email, name, role, courseId } = (await req.json()) as AddEnrollmentRequest;
  if (!courseId) {
    throw new UserVisibleError("Course ID is required");
  }
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
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
