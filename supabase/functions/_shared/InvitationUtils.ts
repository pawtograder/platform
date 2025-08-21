import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "./SupabaseTypes.d.ts";
import { UserVisibleError } from "./HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
import Bottleneck from "npm:bottleneck@2.19.5";

// Types for invitation processing
export interface InvitationRequest {
  sis_user_id: string;
  role: "student" | "grader" | "instructor";
  email?: string;
  name?: string;
  class_section_id?: number;
  lab_section_id?: number;
}

export interface InvitationResult {
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
}

export interface InvitationError {
  sis_user_id: string;
  error: string;
}

export interface BulkInvitationResult {
  success: boolean;
  invitations: InvitationResult[];
  errors: InvitationError[];
}

// Create a rate limiter to prevent database overload (max 10 concurrent operations)
const invitationLimiter = new Bottleneck({
  maxConcurrent: 10,
  minTime: 50 // 50ms between each operation
});

/**
 * Creates invitations for users in bulk using concurrent processing with rate limiting
 * This is the core invitation creation logic used by both SIS import and the invitation API
 */
export async function createInvitationsBulk(
  supabaseClient: ReturnType<typeof createClient<Database>>,
  courseId: number,
  invitedByUserId: string,
  invitations: InvitationRequest[],
  scope?: Sentry.Scope
): Promise<BulkInvitationResult> {
  scope?.setTag("invitationCount", invitations.length.toString());

  // Process all invitations concurrently with rate limiting
  const results = await Promise.all(
    invitations.map((invitation) =>
      invitationLimiter.schedule(() => processInvitation(supabaseClient, courseId, invitedByUserId, invitation, scope))
    )
  );

  // Separate successful invitations from errors
  const successfulInvitations: InvitationResult[] = [];
  const errors: InvitationError[] = [];

  for (const result of results) {
    if (result.success) {
      successfulInvitations.push(result.invitation!);
    } else {
      errors.push(result.error!);
    }
  }

  scope?.setContext("invitation_results", {
    successful: successfulInvitations.length,
    errors: errors.length,
    total: invitations.length
  });

  return {
    success: successfulInvitations.length > 0,
    invitations: successfulInvitations,
    errors
  };
}

/**
 * Internal function to process a single invitation with all validation and creation logic
 */
async function processInvitation(
  supabaseClient: ReturnType<typeof createClient<Database>>,
  courseId: number,
  invitedByUserId: string,
  invitation: InvitationRequest,
  scope?: Sentry.Scope
): Promise<{ success: true; invitation: InvitationResult } | { success: false; error: InvitationError }> {
  try {
    // Validate required fields
    if (!invitation.sis_user_id?.trim()) {
      return {
        success: false,
        error: {
          sis_user_id: invitation.sis_user_id || "unknown",
          error: "SIS User ID is required"
        }
      };
    }

    if (!invitation.role || !["student", "grader", "instructor"].includes(invitation.role)) {
      return {
        success: false,
        error: {
          sis_user_id: invitation.sis_user_id,
          error: "Valid role is required (student, grader, or instructor)"
        }
      };
    }

    // Check if user already exists and is enrolled
    const { data: existingUser } = await supabaseClient
      .from("users")
      .select("user_id")
      .eq("sis_user_id", invitation.sis_user_id)
      .single();

    if (existingUser) {
      // Check if already enrolled
      const { data: existingEnrollment } = await supabaseClient
        .from("user_roles")
        .select("role")
        .eq("user_id", existingUser.user_id)
        .eq("class_id", courseId)
        .single();

      if (existingEnrollment) {
        return {
          success: false,
          error: {
            sis_user_id: invitation.sis_user_id,
            error: `User is already enrolled with role: ${existingEnrollment.role}`
          }
        };
      }
    }

    // Check if invitation already exists
    const { data: existingInvitation } = await supabaseClient
      .from("invitations")
      .select("id, status")
      .eq("class_id", courseId)
      .eq("sis_user_id", invitation.sis_user_id)
      .eq("status", "pending")
      .single();

    if (existingInvitation) {
      return {
        success: false,
        error: {
          sis_user_id: invitation.sis_user_id,
          error: "Pending invitation already exists for this user"
        }
      };
    }

    // Create invitation using the database function
    const { data: invitationResult, error: invitationError } = await supabaseClient.rpc("create_invitation", {
      p_class_id: courseId,
      p_role: invitation.role as Database["public"]["Enums"]["app_role"],
      p_sis_user_id: invitation.sis_user_id,
      p_email: invitation.email || null,
      p_name: invitation.name || null,
      p_invited_by: invitedByUserId,
      p_class_section_id: invitation.class_section_id || null,
      p_lab_section_id: invitation.lab_section_id || null
    });

    if (invitationError) {
      scope?.addBreadcrumb({
        message: `Error creating invitation for ${invitation.sis_user_id}`,
        category: "error",
        data: { error: invitationError.message }
      });
      return {
        success: false,
        error: {
          sis_user_id: invitation.sis_user_id,
          error: invitationError.message
        }
      };
    }

    // Fetch the created invitation details
    const { data: createdInvitation, error: fetchError } = await supabaseClient
      .from("invitations")
      .select(
        `
        id,
        sis_user_id,
        role,
        email,
        name,
        status,
        created_at,
        expires_at,
        class_section_id,
        lab_section_id
      `
      )
      .eq("id", invitationResult)
      .single();

    if (fetchError) {
      scope?.addBreadcrumb({
        message: `Error fetching created invitation for ${invitation.sis_user_id}`,
        category: "error",
        data: { error: fetchError.message }
      });
      return {
        success: false,
        error: {
          sis_user_id: invitation.sis_user_id,
          error: "Invitation created but failed to fetch details"
        }
      };
    }

    scope?.addBreadcrumb({
      message: `Created invitation for ${invitation.sis_user_id}`,
      category: "success",
      data: { invitation_id: createdInvitation.id }
    });

    return {
      success: true,
      invitation: {
        id: createdInvitation.id,
        sis_user_id: createdInvitation.sis_user_id,
        role: createdInvitation.role,
        email: createdInvitation.email || undefined,
        name: createdInvitation.name || undefined,
        status: createdInvitation.status,
        created_at: createdInvitation.created_at,
        expires_at: createdInvitation.expires_at || "",
        class_section_id: createdInvitation.class_section_id || undefined,
        lab_section_id: createdInvitation.lab_section_id || undefined
      }
    };
  } catch (error) {
    scope?.addBreadcrumb({
      message: `Error processing invitation for ${invitation.sis_user_id}`,
      category: "error",
      data: { error: error.message }
    });
    return {
      success: false,
      error: {
        sis_user_id: invitation.sis_user_id,
        error: error.message
      }
    };
  }
}

/**
 * Validates invitation request data for API endpoints
 */
export function validateInvitationRequest(
  courseId: number,
  invitations: InvitationRequest[],
  maxInvitations?: number
): void {
  if (!courseId) {
    throw new UserVisibleError("Course ID is required");
  }

  if (!invitations || !Array.isArray(invitations) || invitations.length === 0) {
    throw new UserVisibleError("At least one invitation is required");
  }

  if (maxInvitations && invitations.length > maxInvitations) {
    throw new UserVisibleError(`Maximum ${maxInvitations} invitations can be created at once`);
  }
}
