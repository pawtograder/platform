import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wrapRequestHandler, assertUserIsInstructor } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import {
  createInvitationsBulk,
  validateInvitationRequest,
  type InvitationRequest
} from "../_shared/InvitationUtils.ts";
import * as Sentry from "npm:@sentry/deno";

// Request/Response types
interface CreateInvitationRequest {
  courseId: number;
  invitations: InvitationRequest[];
}

interface CreateInvitationResponse {
  success: boolean;
  invitations: Array<{
    id: number;
    sis_user_id: string;
    role: string;
    email?: string;
    name?: string;
    status: string;
    created_at: string;
    expires_at: string;
    class_section_id?: number;
    lab_section_id?: number;
  }>;
  errors?: Array<{
    sis_user_id: string;
    error: string;
  }>;
}

/**
 * Edge function to create course invitations for users who don't have accounts yet.
 * Only instructors or admins can create invitations.
 */
async function handleRequest(req: Request, scope: Sentry.Scope): Promise<CreateInvitationResponse> {
  scope?.setTag("function", "invitation-create");

  const { courseId, invitations } = (await req.json()) as CreateInvitationRequest;

  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("invitationCount", invitations.length.toString());

  // Validate that the user is an instructor for this course
  const { supabase, enrollment } = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);

  scope?.setUser({
    id: enrollment.user_id,
    email: enrollment.email
  });

  // Use shared utility to create invitations
  const result = await createInvitationsBulk(
    supabase, //Act as user!
    courseId,
    enrollment.user_id,
    invitations,
    scope
  );

  return {
    success: result.success,
    invitations: result.invitations,
    errors: result.errors.length > 0 ? result.errors : undefined
  };
}

Deno.serve(async (req: Request) => {
  return await wrapRequestHandler(req, handleRequest);
});
