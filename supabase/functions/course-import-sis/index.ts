import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wrapRequestHandler, UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { createInvitationsBulk, type InvitationRequest } from "../_shared/InvitationUtils.ts";
import * as Sentry from "npm:@sentry/deno";

// SIS API Types
interface SISCRNResponse {
  [courseCode: string]: number[];
}

interface SISRosterResponse {
  [crn: string]: {
    section_meta: {
      course: string;
      title: string;
      start_date: string;
      end_date: string;
      meeting_location: string;
      meeting_times: string;
      campus: string;
    };
    instructors: Array<{
      nuid: number;
      first_name: string;
      last_name: string;
    }>;
    tas: Array<{
      nuid: number;
      first_name: string;
      last_name: string;
    }>;
    students: Array<{
      nuid: string;
      first_name: string;
      last_name: string;
    }>;
  };
}

// Request/Response Types
interface CourseImportRequest {
  term: string;
  mainCourseCode: string;
  labCourseCode?: string;
}

interface ProcessedSection {
  crn: number;
  sectionType: "class" | "lab";
  sectionName: string;
  meetingInfo: string;
  location: string;
  instructors: Array<{
    sis_user_id: string;
    name: string;
    role: "instructor";
  }>;
  tas: Array<{
    sis_user_id: string;
    name: string;
    role: "grader";
  }>;
  students: Array<{
    sis_user_id: string;
    name: string;
    role: "student";
  }>;
}

interface CourseImportResponse {
  success: boolean;
  courseInfo: {
    course: string;
    title: string;
    startDate: string;
    endDate: string;
    campus: string;
  };
  sections: ProcessedSection[];
  totalUsers: {
    instructors: number;
    graders: number;
    students: number;
  };
  enrollmentStatus: {
    instructors: {
      inSIS: number;
      inPawtograder: number;
      pendingInvitations: number;
      newInvitations: number;
    };
    graders: {
      inSIS: number;
      inPawtograder: number;
      pendingInvitations: number;
      newInvitations: number;
    };
    students: {
      inSIS: number;
      inPawtograder: number;
      pendingInvitations: number;
      newInvitations: number;
    };
  };
}

/**
 * Sync existing SIS-linked classes with latest enrollment data
 */
async function syncSISClasses(supabase: SupabaseClient<Database>, classId: number | null, scope: Sentry.Scope) {
  scope?.setTag("function", "sis-sync");

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Get SIS API configuration
  const SIS_API_URL = Deno.env.get("SIS_API_URL");
  const SIS_AUTH_TOKEN = Deno.env.get("SIS_AUTH_TOKEN");

  if (!SIS_API_URL || !SIS_AUTH_TOKEN) {
    throw new UserVisibleError("SIS API configuration missing");
  }

  // Find classes that have SIS-linked sections (have sis_crn)
  const classQuery = adminSupabase
    .from("classes")
    .select(
      `
      id, name, term,
      class_sections!inner(id, sis_crn),
      lab_sections!inner(id, sis_crn)
    `
    )
    .not("class_sections.sis_crn", "is", null);

  if (classId) {
    classQuery.eq("id", classId);
  }

  const { data: sisLinkedClasses, error } = await classQuery;

  if (error) {
    throw new UserVisibleError(`Failed to fetch SIS-linked classes: ${error.message}`);
  }

  if (!sisLinkedClasses || sisLinkedClasses.length === 0) {
    scope?.addBreadcrumb({
      message: "No SIS-linked classes found to sync",
      category: "info"
    });
    return { synced: 0, errors: 0 };
  }

  scope?.setTag("classes_to_sync", sisLinkedClasses.length.toString());

  let syncedCount = 0;
  let errorCount = 0;

  // Process each class
  for (const classData of sisLinkedClasses) {
    try {

      // Check if sync is enabled for sections in this class
      const { data: syncStatus } = await adminSupabase
        .from("sis_sync_status")
        .select("sync_enabled, course_section_id, lab_section_id")
        .eq("course_id", classData.id);

      // Get enabled sections only
      const enabledClassSections = classData.class_sections.filter(s => {
        const status = syncStatus?.find(ss => ss.course_section_id === s.id);
        return status ? status.sync_enabled : true; // Default to enabled if no status record
      });

      const enabledLabSections = classData.lab_sections.filter(s => {
        const status = syncStatus?.find(ss => ss.lab_section_id === s.id);
        return status ? status.sync_enabled : true; // Default to enabled if no status record
      });

      if (enabledClassSections.length === 0 && enabledLabSections.length === 0) {
        scope?.addBreadcrumb({
          message: `All sections disabled for class ${classData.name}`,
          category: "info",
          data: { classId: classData.id }
        });
        continue;
      }

      // Get all CRNs for enabled sections only
      const allCRNs = [
        ...enabledClassSections.map((s) => s.sis_crn).filter((crn) => crn !== null),
        ...enabledLabSections.map((s) => s.sis_crn).filter((crn) => crn !== null)
      ];

      // Fetch current rosters for all CRNs
      const rosterPromises = allCRNs.map(async (crn) => {
        const response = await fetch(`${SIS_API_URL}/roster/?semester=${classData.term}&crn=${crn}`, {
          headers: { Authorization: `Token ${SIS_AUTH_TOKEN}` }
        });

        if (!response.ok) {
          scope?.addBreadcrumb({
            message: `Failed to fetch roster for CRN ${crn}`,
            category: "error",
            data: { classId: classData.id, crn, status: response.status }
          });
          throw new UserVisibleError(
            `Failed to fetch roster for CRN ${crn}: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json() as SISRosterResponse;
        return { crn, roster: data[crn.toString()] };
      });

      const rosterResults = (await Promise.all(rosterPromises)).filter((r) => r !== null);

      if (rosterResults.length === 0) {
        scope?.addBreadcrumb({
          message: `No roster data available for class ${classData.name}`,
          category: "warning",
          data: { classId: classData.id }
        });
        continue;
      }

      // SYNC LOGIC IMPLEMENTATION

      // Step 1: Process SIS roster data for this class
      const sisEnrollmentByCRN = new Map<
        number,
        {
          sectionType: "class" | "lab";
          instructors: Array<{ sis_user_id: string; name: string; role: "instructor" }>;
          graders: Array<{ sis_user_id: string; name: string; role: "grader" }>;
          students: Array<{ sis_user_id: string; name: string; role: "student" }>;
          sectionMeta: {
            meeting_location: string;
            meeting_times: string;
            campus: string;
          };
        }
      >();

      rosterResults.forEach(({ crn, roster }) => {
        if (!roster) return;

        // Determine section type based on enabled sections
        const isClassSection = enabledClassSections.some((s) => s.sis_crn === crn);
        const sectionType = isClassSection ? "class" : "lab";

        sisEnrollmentByCRN.set(crn, {
          sectionType,
          instructors: roster.instructors.map((inst) => ({
            sis_user_id: inst.nuid.toString(),
            name: `${inst.first_name} ${inst.last_name}`,
            role: "instructor" as const
          })),
          graders: roster.tas.map((ta) => ({
            sis_user_id: ta.nuid.toString(),
            name: `${ta.first_name} ${ta.last_name}`,
            role: "grader" as const
          })),
          students: roster.students.map((student) => ({
            sis_user_id: student.nuid,
            name: `${student.first_name} ${student.last_name}`,
            role: "student" as const
          })),
          sectionMeta: roster.section_meta
        });
      });

      // Step 2: Get current invitations and enrollments for this class
      const { data: currentInvitations } = await adminSupabase
        .from("invitations")
        .select("id, sis_user_id, role, status, class_section_id, lab_section_id")
        .eq("class_id", classData.id);

      const { data: currentEnrollments } = await adminSupabase
        .from("user_roles")
        .select(
          "id, role, class_section_id, lab_section_id, canvas_id, disabled, users!inner(sis_user_id)"
        )
        .eq("class_id", classData.id)
        .not("users.sis_user_id", "is", null);

      // Step 3: Build current state maps
      const currentInvitationsBySIS = new Map((currentInvitations || []).map((inv) => [inv.sis_user_id, inv]));

      const currentEnrollmentsBySIS = new Map((currentEnrollments || []).map((enr) => [enr.users.sis_user_id, enr]));

      // Step 4: Collect all SIS users across all sections for this class
      const allSISUsers = new Map<
        string,
        {
          name: string;
          role: "instructor" | "grader" | "student";
          crn: number;
          sectionType: "class" | "lab";
        }
      >();

      sisEnrollmentByCRN.forEach((sectionData, crn) => {
        [...sectionData.instructors, ...sectionData.graders, ...sectionData.students].forEach((user) => {
          // Use role hierarchy - highest role wins if user appears in multiple sections
          const existing = allSISUsers.get(user.sis_user_id);
          const roleHierarchy = { instructor: 3, grader: 2, student: 1 };

          if (!existing || roleHierarchy[user.role] > roleHierarchy[existing.role]) {
            allSISUsers.set(user.sis_user_id, {
              name: user.name,
              role: user.role,
              crn,
              sectionType: sectionData.sectionType
            });
          }
        });
      });

      let newInvitationsCount = 0;
      let expiredInvitationsCount = 0;
      let disabledUsersCount = 0;
      let reenabledUsersCount = 0;
      let updatedMetadataCount = 0;

      // Step 5: Create invitations for new SIS users
      const newInvitations: InvitationRequest[] = [];

      for (const [sisUserId, userData] of allSISUsers) {
        // Skip if user is already enrolled
        if (currentEnrollmentsBySIS.has(sisUserId)) {
          continue;
        }

        // Skip if user already has a pending invitation with the same role
        const existingInvitation = currentInvitationsBySIS.get(sisUserId);
        if (
          existingInvitation &&
          existingInvitation.status === "pending" &&
          existingInvitation.role === userData.role
        ) {
          continue;
        }

        // Get section IDs based on CRN and section type
        let classSectionId = null;
        let labSectionId = null;

        if (userData.sectionType === "class") {
          const section = await adminSupabase
            .from("class_sections")
            .select("id")
            .eq("class_id", classData.id)
            .eq("sis_crn", userData.crn)
            .single();
          classSectionId = section.data?.id || null;
        } else {
          const section = await adminSupabase
            .from("lab_sections")
            .select("id")
            .eq("class_id", classData.id)
            .eq("sis_crn", userData.crn)
            .single();
          labSectionId = section.data?.id || null;
        }

        newInvitations.push({
          sis_user_id: sisUserId,
          role: userData.role,
          name: userData.name,
          class_section_id: classSectionId || undefined,
          lab_section_id: labSectionId || undefined
        });
      }

      // Create new invitations in bulk using shared utility (no limit on count)
      if (newInvitations.length > 0) {
        try {
          // Find a system user or admin to use as the inviter
          // For SIS sync operations, we'll use the first admin user in the system
          const { data: adminUser, error: adminError } = await adminSupabase
            .from("user_roles")
            .select("user_id")
            .eq("role", "admin")
            .eq("disabled", false)
            .limit(1)
            .single();

          if (adminError || !adminUser) {
            scope?.addBreadcrumb({
              message: "No admin user found for SIS sync invitations",
              category: "error",
              data: { error: adminError?.message }
            });
            throw new UserVisibleError("No admin user available to create invitations");
          }

          scope?.addBreadcrumb({
            message: `Creating ${newInvitations.length} invitations via shared utility`,
            category: "info",
            data: { classId: classData.id, count: newInvitations.length }
          });

          // Use shared utility to create all invitations at once (no batching needed)
          const inviteResult = await createInvitationsBulk(
            supabase, //Act as user!
            classData.id,
            adminUser.user_id,
            newInvitations,
            scope
          );

          newInvitationsCount = inviteResult.invitations.length;

          // Log summary of results
          scope?.addBreadcrumb({
            message: `Invitation creation complete: ${inviteResult.invitations.length} created, ${inviteResult.errors.length} errors`,
            category: "info",
            data: {
              classId: classData.id,
              totalProcessed: newInvitations.length,
              totalCreated: inviteResult.invitations.length,
              totalErrors: inviteResult.errors.length
            }
          });

          // If we have some errors but also some successes, log but don't fail completely
          if (inviteResult.errors.length > 0) {
            scope?.addBreadcrumb({
              message: `SIS Import: ${inviteResult.errors.length} invitation errors encountered`,
              category: "warning",
              data: {
                classId: classData.id,
                errorCount: inviteResult.errors.length,
                sampleErrors: inviteResult.errors.slice(0, 5) // Include first 5 errors for context
              }
            });
          }
        } catch (error) {
          scope?.addBreadcrumb({
            message: `Error in invitation creation`,
            category: "error",
            data: { classId: classData.id, error: error instanceof Error ? error.message : String(error) }
          });
          throw new UserVisibleError(`Failed to create invitations: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Step 6: Handle users no longer in SIS
      const sisUserIds = new Set(allSISUsers.keys());

      // 6a. Mark invitations as expired for users no longer in SIS
      const invitationsToExpire = (currentInvitations || []).filter(
        (inv) => inv.status === "pending" && !sisUserIds.has(inv.sis_user_id)
      );

      if (invitationsToExpire.length > 0) {
        const { error: expireError } = await adminSupabase
          .from("invitations")
          .update({
            status: "expired",
            updated_at: new Date().toISOString()
          })
          .in(
            "id",
            invitationsToExpire.map((inv) => inv.id)
          );

        if (expireError) {
          scope?.addBreadcrumb({
            message: `Failed to expire ${invitationsToExpire.length} old invitations`,
            category: "error",
            data: { classId: classData.id, error: expireError }
          });
        } else {
          expiredInvitationsCount = invitationsToExpire.length;
        }
      }

      // 6b. Disable user_roles for enrolled users no longer in SIS (using canvas_id as nuid tracker)
      // Only disable users who were originally from SIS (have canvas_id set to their nuid)
      const enrolledUsersToDisable = (currentEnrollments || []).filter(
        (enr) => enr.users.sis_user_id && enr.canvas_id && !sisUserIds.has(enr.users.sis_user_id) && !enr.disabled // Don't re-disable already disabled users
      );

      if (enrolledUsersToDisable.length > 0) {
        const { error: disableError, count } = await adminSupabase
          .from("user_roles")
          .update({
            disabled: true,
            updated_at: new Date().toISOString()
          })
          .eq("class_id", classData.id)
          .in(
            "canvas_id",
            enrolledUsersToDisable.map((enr) => enr.canvas_id)
          )
          .eq("disabled", false); // Only disable currently active users

        if (disableError) {
          scope?.addBreadcrumb({
            message: `Failed to disable ${enrolledUsersToDisable.length} dropped users`,
            category: "error",
            data: { classId: classData.id, error: disableError }
          });
        } else {
          disabledUsersCount = count || 0;
        }
      }

      // 6c. Re-enable users who are back in SIS (were disabled but now present again)
      const usersToReenable = (currentEnrollments || []).filter(
        (enr) => enr.users.sis_user_id && enr.canvas_id && sisUserIds.has(enr.users.sis_user_id) && enr.disabled // Only re-enable currently disabled users
      );

      if (usersToReenable.length > 0) {
        const { error: reenableError, count } = await adminSupabase
          .from("user_roles")
          .update({
            disabled: false,
            updated_at: new Date().toISOString()
          })
          .eq("class_id", classData.id)
          .in(
            "canvas_id",
            usersToReenable.map((enr) => enr.canvas_id)
          )
          .eq("disabled", true); // Only re-enable currently disabled users

        if (reenableError) {
          scope?.addBreadcrumb({
            message: `Failed to re-enable ${usersToReenable.length} returning users`,
            category: "error",
            data: { classId: classData.id, error: reenableError }
          });
        } else {
          reenabledUsersCount = count || 0;
        }
      }

      // Step 7: Update section metadata if changed
      for (const [crn, sectionData] of sisEnrollmentByCRN) {
        const sectionMeta = sectionData.sectionMeta;

        if (sectionData.sectionType === "class") {
          const { error: updateError } = await adminSupabase
            .from("class_sections")
            .update({
              meeting_location: sectionMeta.meeting_location,
              meeting_times: sectionMeta.meeting_times,
              updated_at: new Date().toISOString()
            })
            .eq("class_id", classData.id)
            .eq("sis_crn", crn);

          if (!updateError) updatedMetadataCount++;
        } else {
          const { error: updateError } = await adminSupabase
            .from("lab_sections")
            .update({
              meeting_location: sectionMeta.meeting_location,
              meeting_times: sectionMeta.meeting_times,
              updated_at: new Date().toISOString()
            })
            .eq("class_id", classData.id)
            .eq("sis_crn", crn);

          if (!updateError) updatedMetadataCount++;
        }
      }

      // Update sync status for all processed sections
      const syncMessage = `Synced ${rosterResults.length} sections. New invitations: ${newInvitationsCount}, Expired: ${expiredInvitationsCount}, Re-enabled: ${reenabledUsersCount}`;
      
      // Update status for class sections
      for (const section of enabledClassSections) {
        if (rosterResults.some(r => r.crn === section.sis_crn)) {
          try {
            await adminSupabase.rpc("update_sis_sync_status", {
              p_course_id: classData.id,
              p_course_section_id: section.id,
              p_sync_status: "success",
              p_sync_message: syncMessage
            });
          } catch (statusError) {
            errorCount++;
            scope?.addBreadcrumb({
              message: `Failed to update sync status for class section ${section.id}`,
              category: "warning",
              data: { error: statusError instanceof Error ? statusError.message : String(statusError) }
            });
          }
        }
      }

      // Update status for lab sections
      for (const section of enabledLabSections) {
        if (rosterResults.some(r => r.crn === section.sis_crn)) {
          try {
            await adminSupabase.rpc("update_sis_sync_status", {
              p_course_id: classData.id,
              p_lab_section_id: section.id,
              p_sync_status: "success",
              p_sync_message: syncMessage
            });
          } catch (statusError) {
            errorCount++;
            scope?.addBreadcrumb({
              message: `Failed to update sync status for lab section ${section.id}`,
              category: "warning",
              data: { error: statusError instanceof Error ? statusError.message : String(statusError) }
            });
          }
        }
      }

      scope?.addBreadcrumb({
        message: `Synced class ${classData.name}`,
        category: "success",
        data: {
          classId: classData.id,
          crnCount: rosterResults.length,
          newInvitations: newInvitationsCount,
          expiredInvitations: expiredInvitationsCount,
          disabledUsers: disabledUsersCount,
          reenabledUsers: reenabledUsersCount,
          updatedMetadata: updatedMetadataCount
        }
      });

      syncedCount++;
    } catch (error) {
      // Update sync status for all sections with error
      const errorMessage = `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
      
      // Update status for class sections
      for (const section of classData.class_sections) {
        try {
          await adminSupabase.rpc("update_sis_sync_status", {
            p_course_id: classData.id,
            p_course_section_id: section.id,
            p_sync_status: "error",
            p_sync_message: errorMessage
          });
        } catch (statusError) {
          scope?.addBreadcrumb({
            message: `Failed to update error status for class section ${section.id}`,
            category: "warning",
            data: { error: statusError instanceof Error ? statusError.message : String(statusError) }
          });
          errorCount++;
        }
      }

      // Update status for lab sections
      for (const section of classData.lab_sections) {
        try {
          await adminSupabase.rpc("update_sis_sync_status", {
            p_course_id: classData.id,
            p_lab_section_id: section.id,
            p_sync_status: "error",
            p_sync_message: errorMessage
          });
        } catch (statusError) {
          scope?.addBreadcrumb({
            message: `Failed to update error status for lab section ${section.id}`,
            category: "warning",
            data: { error: statusError instanceof Error ? statusError.message : String(statusError) }
          });
          errorCount++;
        }
      }

      scope?.addBreadcrumb({
        message: `Failed to sync class ${classData.name}`,
        category: "error",
        data: { classId: classData.id, error: error instanceof Error ? error.message : String(error) }
      });
      errorCount++;
    }
  }

  scope?.setContext("sync_summary", {
    classesProcessed: sisLinkedClasses.length,
    synced: syncedCount,
    errors: errorCount
  });

  return {
    synced: syncedCount,
    errors: errorCount,
    totalClasses: sisLinkedClasses.length,
    message: `Synced ${syncedCount} classes (${errorCount} errors)`
  };
}

// function constructSemesterCode(term: string, year: number): string {
//   const termMap: { [key: string]: string } = {
//     Fall: "10",
//     Spring: "20",
//     "Summer 1": "30",
//     "Summer 2": "40"
//   };

//   const termCode = termMap[term] || "10";
//   return `${year}${termCode}`;
// }

/**
 * Edge function to import course data from SIS API
 * Supports both direct user calls (JWT) and postgres cron jobs (edge function secret)
 */
async function handleRequest(req: Request, scope: Sentry.Scope): Promise<CourseImportResponse | { message: string }> {
  scope?.setTag("function", "course-import-sis");

  // Check for edge function secret authentication (for pg_cron)
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // Called from postgres - sync existing SIS classes
    const url = new URL(req.url);
    const classId = url.searchParams.get("classId");

    scope?.setTag("source", "postgres-cron");
    scope?.setTag("classId", classId || "all");
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const syncHandler = async () => {
      try {
        //TODO will throw error because validates auth.uid()
        const result = await syncSISClasses(adminSupabase, classId ? parseInt(classId) : null, scope);
        scope?.setContext("sync_result", result);
      } catch (error) {
        scope?.captureException(error);
        throw error;
      }
    };

    // Run in background for cron jobs
    EdgeRuntime.waitUntil(syncHandler());

    return {
      message: "SIS sync started in background"
    };
  }

  // Direct user call - import new course
  scope?.setTag("source", "user-direct");

  const { term, mainCourseCode, labCourseCode } = (await req.json()) as CourseImportRequest;

  // Validate required inputs for new course import
  if (!term?.trim()) {
    throw new UserVisibleError("Term code is required");
  }
  if (!mainCourseCode?.trim()) {
    throw new UserVisibleError("Main course code is required");
  }

  scope?.setTag("term", term);
  scope?.setTag("mainCourseCode", mainCourseCode);
  scope?.setTag("labCourseCode", labCourseCode || "none");

  // Validate admin authorization for direct user calls
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } }
  });

  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new UserVisibleError("Authentication required");
  }

  // Check admin role
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: isAdmin } = await adminSupabase.rpc("authorize_for_admin", {
    p_user_id: user.id
  });

  if (!isAdmin) {
    throw new UserVisibleError("Admin role required");
  }

  scope?.setUser({ id: user.id, email: user.email });

  // Get SIS API configuration
  const SIS_API_URL = Deno.env.get("SIS_API_URL");
  const SIS_AUTH_TOKEN = Deno.env.get("SIS_AUTH_TOKEN");

  if (!SIS_API_URL || !SIS_AUTH_TOKEN) {
    throw new UserVisibleError("SIS API configuration missing");
  }

  try {
    const courseCodes = [mainCourseCode.trim()];
    if (labCourseCode?.trim()) {
      courseCodes.push(labCourseCode.trim());
    }

    // Step 1: Get CRNs for all courses
    const crnPromises = courseCodes.map(async (courseCode) => {
      const crnResponse = await fetch(`${SIS_API_URL}/?semester=${term}&course=${courseCode}`, {
        headers: {
          Authorization: `Token ${SIS_AUTH_TOKEN}`
        }
      });

      if (!crnResponse.ok) {
        throw new UserVisibleError(
          `Failed to fetch CRNs for ${courseCode}: ${crnResponse.status} ${crnResponse.statusText}`
        );
      }

      const crnData: SISCRNResponse = await crnResponse.json();
      return {
        courseCode,
        crns: crnData[courseCode] || []
      };
    });

    const courseResults = await Promise.all(crnPromises);

    const mainCourseCRNs = courseResults.find((r) => r.courseCode === mainCourseCode)?.crns || [];
    const labCourseCRNs = courseResults.find((r) => r.courseCode === labCourseCode)?.crns || [];

    if (mainCourseCRNs.length === 0) {
      throw new UserVisibleError(`No sections found for course ${mainCourseCode} in term ${term}`);
    }

    scope?.setContext("course_crns", {
      main: mainCourseCRNs,
      lab: labCourseCRNs,
      total: mainCourseCRNs.length + labCourseCRNs.length
    });

    // Step 2: Get roster data for all CRNs
    const allCRNs = [...mainCourseCRNs, ...labCourseCRNs];
    const rosterPromises = allCRNs.map(async (crn) => {
      const rosterResponse = await fetch(`${SIS_API_URL}/roster/?semester=${term}&crn=${crn}`, {
        headers: {
          Authorization: `Token ${SIS_AUTH_TOKEN}`
        }
      });

      if (!rosterResponse.ok) {
        scope?.addBreadcrumb({
          message: `Failed to fetch roster for CRN ${crn}`,
          category: "error",
          data: {
            crn,
            status: rosterResponse.status,
            statusText: rosterResponse.statusText
          }
        });
        throw new UserVisibleError(
          `Failed to fetch roster for CRN ${crn}: ${rosterResponse.status} ${rosterResponse.statusText}`
        );
      }

      const rosterData: SISRosterResponse = await rosterResponse.json();
      return {
        crn,
        data: rosterData[crn.toString()],
        sectionType: mainCourseCRNs.includes(crn) ? ("class" as const) : ("lab" as const)
      };
    });

    const rosterResults = (await Promise.all(rosterPromises)).filter((r) => r !== null);

    if (rosterResults.length === 0) {
      throw new UserVisibleError("No roster data could be retrieved");
    }

    // Step 3: Process the data
    const sections: ProcessedSection[] = rosterResults.map(({ crn, data, sectionType }) => {
      // Extract section name from course code and meeting info
      const courseParts = data.section_meta.course.split(" ");
      const courseNumber = courseParts[1] || "Unknown";
      const sectionName = `${courseNumber} - ${data.section_meta.meeting_times}`;

      return {
        crn,
        sectionType,
        sectionName,
        meetingInfo: data.section_meta.meeting_times,
        location: data.section_meta.meeting_location,
        instructors: data.instructors.map((inst) => ({
          sis_user_id: inst.nuid.toString(),
          name: `${inst.first_name} ${inst.last_name}`,
          role: "instructor" as const
        })),
        tas: data.tas.map((ta) => ({
          sis_user_id: ta.nuid.toString(),
          name: `${ta.first_name} ${ta.last_name}`,
          role: "grader" as const
        })),
        students: data.students.map((student) => ({
          sis_user_id: student.nuid,
          name: `${student.first_name} ${student.last_name}`,
          role: "student" as const
        }))
      };
    });

    // Get course info from the first main course section
    const firstMainSection = rosterResults.find((r) => r.sectionType === "class");
    if (!firstMainSection) {
      throw new UserVisibleError("No main course section data found");
    }

    const courseInfo = {
      course: firstMainSection.data.section_meta.course,
      title: firstMainSection.data.section_meta.title,
      startDate: firstMainSection.data.section_meta.start_date,
      endDate: firstMainSection.data.section_meta.end_date,
      campus: firstMainSection.data.section_meta.campus
    };

    // Calculate totals and check existing enrollment status
    const allInstructors = new Set(sections.flatMap((s) => s.instructors.map((i) => i.sis_user_id)));
    const allGraders = new Set(sections.flatMap((s) => s.tas.map((t) => t.sis_user_id)));
    const allStudents = new Set(sections.flatMap((s) => s.students.map((st) => st.sis_user_id)));

    const totalUsers = {
      instructors: allInstructors.size,
      graders: allGraders.size,
      students: allStudents.size
    };

    // Check existing users in Pawtograder
    const allSISUserIds = [...allInstructors, ...allGraders, ...allStudents];

    const { data: existingUsers } = await adminSupabase
      .from("users")
      .select("sis_user_id")
      .in("sis_user_id", allSISUserIds)
      .not("sis_user_id", "is", null);

    const existingSISIds = new Set(existingUsers?.map((u) => u.sis_user_id) || []);

    // Check pending invitations (we don't know which class they'll be imported to yet, so check globally)
    const { data: pendingInvitations } = await adminSupabase
      .from("invitations")
      .select("sis_user_id, role")
      .in("sis_user_id", allSISUserIds)
      .eq("status", "pending");

    const pendingInvitationsByRole = {
      instructor: new Set(pendingInvitations?.filter((i) => i.role === "instructor").map((i) => i.sis_user_id) || []),
      grader: new Set(pendingInvitations?.filter((i) => i.role === "grader").map((i) => i.sis_user_id) || []),
      student: new Set(pendingInvitations?.filter((i) => i.role === "student").map((i) => i.sis_user_id) || [])
    };

    // Calculate enrollment status for each role
    const calculateRoleStatus = (sisUsers: Set<string>, role: "instructor" | "grader" | "student") => {
      const inPawtograder = Array.from(sisUsers).filter((id) => existingSISIds.has(id)).length;
      const pendingInvitations = Array.from(sisUsers).filter((id) => pendingInvitationsByRole[role].has(id)).length;
      const newInvitations = sisUsers.size - inPawtograder - pendingInvitations;

      return {
        inSIS: sisUsers.size,
        inPawtograder,
        pendingInvitations,
        newInvitations
      };
    };

    const enrollmentStatus = {
      instructors: calculateRoleStatus(allInstructors, "instructor"),
      graders: calculateRoleStatus(allGraders, "grader"),
      students: calculateRoleStatus(allStudents, "student")
    };

    scope?.setContext("import_results", {
      sections: sections.length,
      totalUsers,
      enrollmentStatus
    });

    return {
      success: true,
      courseInfo,
      sections,
      totalUsers,
      enrollmentStatus
    };
  } catch (error) {
    scope?.captureException(error);
    throw error instanceof UserVisibleError ? error : new UserVisibleError(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Main handler that routes between import and sync functionality
async function routeRequest(req: Request, scope: Sentry.Scope) {
  // Check for edge function secret authentication (for pg_cron)
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET");

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // Called from postgres cron - sync existing classes
    const url = new URL(req.url);
    const classId = url.searchParams.get("classId");

    scope?.setTag("source", "postgres-cron");
    scope?.setTag("classId", classId || "all");

    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const syncHandler = async () => {
      try {
        //TODO will throw error because validates auth.uid()
        const result = await syncSISClasses(adminSupabase, classId ? parseInt(classId) : null, scope);
        scope?.setContext("sync_result", result);
      } catch (error) {
        scope?.captureException(error);
      }
    };

    // Run in background for cron jobs
    EdgeRuntime.waitUntil(syncHandler());

    return {
      message: "SIS sync started in background",
      classId: classId || "all"
    };
  } else {
    // Direct user call - import new course
    scope?.setTag("source", "user-direct");
    return await handleRequest(req, scope);
  }
}

Deno.serve(async (req: Request) => {
  return await wrapRequestHandler(req, routeRequest);
});
