#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Manual SIS Sync Script
 *
 * This script provides manual operations for SIS integration:
 * - List complete roster from SIS for a Pawtograder course (export to CSV)
 * - Manually trigger sync of a single CRN
 * - Utility functions for testing and debugging
 *
 * Usage:
 *   deno run --allow-net --allow-env --allow-read --allow-write manualSync.ts <command> [options]
 *
 * Commands:
 *   list-roster <classId>              - List complete roster for a Pawtograder class
 *   export-csv <classId> <filename>    - Export roster to CSV file
 *   sync-crn <crn> <term>             - Manually sync a single CRN
 *   sync-class <classId>              - Manually sync all CRNs for a class
 *   test-sis-api <term> <courseCode>  - Test SIS API connectivity
 *
 * Environment Variables Required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIS_API_URL, SIS_AUTH_TOKEN
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

// Import types and functions from the main index.ts
import {
  fetchWithRetry,
  syncSISClasses,
  createMockScope,
  type SISCRNResponse,
  type SISRosterResponse
} from "./index.ts";

interface RosterEntry {
  sisUserId: number;
  firstName: string;
  lastName: string;
  fullName: string;
  role: "instructor" | "grader" | "student";
  courseCRN: number | null;
  courseSectionName: string | null;
  labCRN: number | null;
  labSectionName: string | null;
  meetingTimes: string | null;
  location: string | null;
}

/**
 * Get numeric precedence for role (higher number = higher precedence)
 */
function getRolePrecedence(role: "instructor" | "grader" | "student"): number {
  switch (role) {
    case "instructor":
      return 3;
    case "grader":
      return 2;
    case "student":
      return 1;
    default:
      return 0;
  }
}

/**
 * Securely escape CSV field to prevent injection attacks
 * Handles quotes, commas, and formula injection (leading =,+,-,@)
 */
function escapeCSVField(value: string | number | null): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);

  // Check for formula injection patterns and prefix with single quote
  if (/^[=+\-@]/.test(str)) {
    return `'${str.replace(/"/g, '""')}`;
  }

  // If field contains quotes, commas, or newlines, wrap in quotes and escape internal quotes
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

// Configuration
class Config {
  static supabaseUrl = Deno.env.get("SUPABASE_URL");
  static supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  static sisApiUrl = Deno.env.get("SIS_API_URL");
  static sisAuthToken = Deno.env.get("SIS_AUTH_TOKEN");

  static validate() {
    const missing = [];
    if (!this.supabaseUrl) missing.push("SUPABASE_URL");
    if (!this.supabaseServiceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!this.sisApiUrl) missing.push("SIS_API_URL");
    if (!this.sisAuthToken) missing.push("SIS_AUTH_TOKEN");

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
  }
}

// Utility Functions

/**
 * Create admin Supabase client
 */
function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(Config.supabaseUrl!, Config.supabaseServiceKey!);
}

/**
 * Fetch roster data from SIS API for a specific CRN
 */
async function fetchSISRoster(crn: number, term: string): Promise<SISRosterResponse[string] | null> {
  const url = `${Config.sisApiUrl}/roster/?semester=${term}&crn=${crn}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: { Authorization: `Token ${Config.sisAuthToken}` }
    },
    3,
    1000
  ); // Add default retry parameters

  const data: SISRosterResponse = await response.json();
  return data[crn.toString()] || null;
}

/**
 * Fetch CRNs for a course code from SIS API
 */
async function fetchSISCRNs(courseCode: string, term: string): Promise<number[]> {
  const url = `${Config.sisApiUrl}/?semester=${term}&course=${courseCode}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: { Authorization: `Token ${Config.sisAuthToken}` }
    },
    3,
    1000
  ); // Add default retry parameters

  const data: SISCRNResponse = await response.json();
  return data[courseCode] || [];
}

/**
 * Get class information from Pawtograder database
 */
async function getClassInfo(classId: number) {
  const supabase = createAdminClient();

  const { data: classData, error } = await supabase
    .from("classes")
    .select(
      `
      id, name, term, course_title,
      class_sections(id, sis_crn, meeting_location, meeting_times),
      lab_sections(id, sis_crn, meeting_location, meeting_times, start_time, end_time, day_of_week)
    `
    )
    .eq("id", classId)
    .single();

  if (error) {
    throw new Error(`Failed to fetch class info: ${error.message}`);
  }

  if (!classData) {
    throw new Error(`Class with ID ${classId} not found`);
  }

  return classData;
}

/**
 * Get complete roster for a Pawtograder class from SIS
 */
async function getCompleteRoster(classId: number): Promise<RosterEntry[]> {
  console.log(`🔍 Fetching complete roster for class ID ${classId}...`);

  // Get class information
  const classData = await getClassInfo(classId);
  console.log(`📚 Class: ${classData.name} (Term: ${classData.term})`);

  // Get all CRNs for this class
  const classCRNs = classData.class_sections
    .filter((s) => s.sis_crn !== null)
    .map((s) => ({ crn: s.sis_crn!, sectionId: s.id, sectionName: `Class-${s.sis_crn}`, type: "class" as const }));

  const labCRNs = classData.lab_sections
    .filter((s) => s.sis_crn !== null)
    .map((s) => ({ crn: s.sis_crn!, sectionId: s.id, sectionName: `Lab-${s.sis_crn}`, type: "lab" as const }));

  const allCRNs = [...classCRNs, ...labCRNs];

  if (allCRNs.length === 0) {
    throw new Error(`No SIS-linked sections found for class ${classData.name}`);
  }

  console.log(`📋 Found ${classCRNs.length} class sections and ${labCRNs.length} lab sections`);

  // Fetch roster data for all CRNs
  const rosterPromises = allCRNs.map(async ({ crn, sectionName, type }) => {
    try {
      console.log(`📊 Fetching roster for ${type} CRN ${crn} (${sectionName})...`);
      const roster = await fetchSISRoster(crn, (classData.term || 0).toString());
      return { crn, sectionName, type, roster };
    } catch (error) {
      console.error(`❌ Failed to fetch roster for CRN ${crn}: ${error}`);
      return { crn, sectionName, type, roster: null };
    }
  });

  const rosterResults = await Promise.all(rosterPromises);

  // Process and combine all roster data
  const userMap = new Map<number, RosterEntry>();

  for (const { crn, sectionName, type, roster } of rosterResults) {
    if (!roster) continue;

    // Process instructors
    for (const instructor of roster.instructors) {
      const sisUserId = instructor.nuid;
      const fullName = `${instructor.first_name} ${instructor.last_name}`;
      const incomingRole = "instructor" as const;

      if (!userMap.has(sisUserId)) {
        userMap.set(sisUserId, {
          sisUserId,
          firstName: instructor.first_name,
          lastName: instructor.last_name,
          fullName,
          role: incomingRole,
          courseCRN: null,
          courseSectionName: null,
          labCRN: null,
          labSectionName: null,
          meetingTimes: roster.section_meta.meeting_times,
          location: roster.section_meta.meeting_location
        });
      } else {
        const entry = userMap.get(sisUserId)!;
        const incomingPrecedence = getRolePrecedence(incomingRole);
        const existingPrecedence = getRolePrecedence(entry.role);

        // If incoming role has higher precedence, upgrade the entry
        if (incomingPrecedence > existingPrecedence) {
          entry.role = incomingRole;
          entry.firstName = instructor.first_name;
          entry.lastName = instructor.last_name;
          entry.fullName = fullName;
          entry.meetingTimes = roster.section_meta.meeting_times;
          entry.location = roster.section_meta.meeting_location;
        }
        // If roles are equal or incoming is lower, only update CRN/section fields
        // (no downgrade of role or role-specific fields)
      }

      const entry = userMap.get(sisUserId)!;
      if (type === "class") {
        entry.courseCRN = crn;
        entry.courseSectionName = sectionName;
      } else {
        entry.labCRN = crn;
        entry.labSectionName = sectionName;
      }
    }

    // Process TAs/graders
    for (const ta of roster.tas) {
      const sisUserId = ta.nuid;
      const fullName = `${ta.first_name} ${ta.last_name}`;
      const incomingRole = "grader" as const;

      if (!userMap.has(sisUserId)) {
        userMap.set(sisUserId, {
          sisUserId,
          firstName: ta.first_name,
          lastName: ta.last_name,
          fullName,
          role: incomingRole,
          courseCRN: null,
          courseSectionName: null,
          labCRN: null,
          labSectionName: null,
          meetingTimes: roster.section_meta.meeting_times,
          location: roster.section_meta.meeting_location
        });
      } else {
        const entry = userMap.get(sisUserId)!;
        const incomingPrecedence = getRolePrecedence(incomingRole);
        const existingPrecedence = getRolePrecedence(entry.role);

        // If incoming role has higher precedence, upgrade the entry
        if (incomingPrecedence > existingPrecedence) {
          entry.role = incomingRole;
          entry.firstName = ta.first_name;
          entry.lastName = ta.last_name;
          entry.fullName = fullName;
          entry.meetingTimes = roster.section_meta.meeting_times;
          entry.location = roster.section_meta.meeting_location;
        }
        // If roles are equal or incoming is lower, only update CRN/section fields
        // (no downgrade of role or role-specific fields)
      }

      const entry = userMap.get(sisUserId)!;
      if (type === "class") {
        entry.courseCRN = crn;
        entry.courseSectionName = sectionName;
      } else {
        entry.labCRN = crn;
        entry.labSectionName = sectionName;
      }
    }

    // Process students
    for (const student of roster.students) {
      const sisUserId = Number(student.nuid);
      const fullName = `${student.first_name} ${student.last_name}`;
      const incomingRole = "student" as const;

      if (!userMap.has(sisUserId)) {
        userMap.set(sisUserId, {
          sisUserId,
          firstName: student.first_name,
          lastName: student.last_name,
          fullName,
          role: incomingRole,
          courseCRN: null,
          courseSectionName: null,
          labCRN: null,
          labSectionName: null,
          meetingTimes: roster.section_meta.meeting_times,
          location: roster.section_meta.meeting_location
        });
      } else {
        const entry = userMap.get(sisUserId)!;
        const incomingPrecedence = getRolePrecedence(incomingRole);
        const existingPrecedence = getRolePrecedence(entry.role);

        // If incoming role has higher precedence, upgrade the entry
        if (incomingPrecedence > existingPrecedence) {
          entry.role = incomingRole;
          entry.firstName = student.first_name;
          entry.lastName = student.last_name;
          entry.fullName = fullName;
          entry.meetingTimes = roster.section_meta.meeting_times;
          entry.location = roster.section_meta.meeting_location;
        }
        // If roles are equal or incoming is lower, only update CRN/section fields
        // (no downgrade of role or role-specific fields)
      }

      const entry = userMap.get(sisUserId)!;
      if (type === "class") {
        entry.courseCRN = crn;
        entry.courseSectionName = sectionName;
      } else {
        entry.labCRN = crn;
        entry.labSectionName = sectionName;
      }
    }
  }

  const finalRoster = Array.from(userMap.values());

  console.log(`✅ Complete roster retrieved:`);
  console.log(`   👨‍🏫 Instructors: ${finalRoster.filter((r) => r.role === "instructor").length}`);
  console.log(`   👨‍💼 Graders: ${finalRoster.filter((r) => r.role === "grader").length}`);
  console.log(`   👨‍🎓 Students: ${finalRoster.filter((r) => r.role === "student").length}`);
  console.log(`   📊 Total: ${finalRoster.length}`);

  return finalRoster.sort((a, b) => {
    // Sort by role (instructor, grader, student), then by name
    const roleOrder = { instructor: 0, grader: 1, student: 2 };
    const roleDiff = roleOrder[a.role] - roleOrder[b.role];
    if (roleDiff !== 0) return roleDiff;
    return a.fullName.localeCompare(b.fullName);
  });
}

/**
 * Export roster to CSV file
 */
async function exportRosterToCSV(roster: RosterEntry[], filename: string): Promise<void> {
  const headers = [
    "SIS User ID",
    "First Name",
    "Last Name",
    "Full Name",
    "Role",
    "Course CRN",
    "Course Section",
    "Lab CRN",
    "Lab Section",
    "Meeting Times",
    "Location"
  ];

  const csvRows = [
    headers.map(escapeCSVField).join(","),
    ...roster.map((entry) =>
      [
        entry.sisUserId,
        entry.firstName,
        entry.lastName,
        entry.fullName,
        entry.role,
        entry.courseCRN,
        entry.courseSectionName,
        entry.labCRN,
        entry.labSectionName,
        entry.meetingTimes,
        entry.location
      ]
        .map(escapeCSVField)
        .join(",")
    )
  ];

  const csvContent = csvRows.join("\n");
  await Deno.writeTextFile(filename, csvContent);

  console.log(`✅ Roster exported to ${filename}`);
  console.log(`📄 ${roster.length} entries written to CSV`);
}

/**
 * Manually sync a single CRN
 */
async function syncSingleCRN(crn: number, term: string): Promise<void> {
  console.log(`🔄 Manually syncing CRN ${crn} for term ${term}...`);

  // Fetch roster data from SIS
  console.log(`📊 Fetching roster data from SIS...`);
  const roster = await fetchSISRoster(crn, term);

  if (!roster) {
    throw new Error(`No roster data found for CRN ${crn} in term ${term}`);
  }

  console.log(`✅ Roster data retrieved:`);
  console.log(`   👨‍🏫 Instructors: ${roster.instructors.length}`);
  console.log(`   👨‍💼 TAs: ${roster.tas.length}`);
  console.log(`   👨‍🎓 Students: ${roster.students.length}`);
  console.log(`   📍 Course: ${roster.section_meta.course}`);
  console.log(`   📚 Title: ${roster.section_meta.title}`);
  console.log(`   🏢 Location: ${roster.section_meta.meeting_location}`);
  console.log(`   ⏰ Times: ${roster.section_meta.meeting_times}`);

  // Find which Pawtograder class this CRN belongs to
  const supabase = createAdminClient();

  const { data: classSection } = await supabase
    .from("class_sections")
    .select("class_id, classes(name, term)")
    .eq("sis_crn", crn)
    .single();

  const { data: labSection } = await supabase
    .from("lab_sections")
    .select("class_id, classes(name, term)")
    .eq("sis_crn", crn)
    .single();

  const section = classSection || labSection;

  if (!section) {
    console.log(`⚠️  CRN ${crn} is not linked to any Pawtograder class`);
    console.log(`   This would be a new import rather than a sync operation`);
    return;
  }

  const classId = section.class_id;
  const className = section.classes?.name || "Unknown";

  console.log(`🎯 Found matching Pawtograder class: ${className} (ID: ${classId})`);

  // Show what will be synced
  console.log(`📋 Will sync:`);
  roster.instructors.forEach((inst) => {
    console.log(`   👨‍🏫 ${inst.first_name} ${inst.last_name} (NUID: ${inst.nuid})`);
  });
  roster.tas.forEach((ta) => {
    console.log(`   👨‍💼 ${ta.first_name} ${ta.last_name} (NUID: ${ta.nuid})`);
  });
  roster.students.forEach((student) => {
    console.log(`   👨‍🎓 ${student.first_name} ${student.last_name} (NUID: ${student.nuid})`);
  });

  // Actually perform the sync for this specific class
  console.log(`\n🔄 Triggering actual sync for class ${classId}...`);

  const mockScope = createMockScope();

  try {
    const result = await syncSISClasses(supabase, classId, mockScope);
    console.log(`✅ Single CRN sync completed: ${result.message}`);
    console.log(`   📊 Synced: ${result.synced} classes`);
    console.log(`   ❌ Errors: ${result.errors}`);

    if (result.synced > 0) {
      console.log(`\n🎉 Sync successful! Students should now have invitations.`);
      console.log(
        `   You can verify by running: deno run --allow-all manualSync.ts debug-student ${classId} <sisUserId>`
      );
    }
  } catch (error) {
    console.error(`❌ Single CRN sync failed: ${error}`);
    throw error;
  }
}

/**
 * Manually sync all CRNs for a specific class
 */
async function syncClass(classId: number): Promise<void> {
  console.log(`🔄 Manually syncing all CRNs for class ID ${classId}...`);

  const classData = await getClassInfo(classId);

  console.log(`🎯 Syncing class: ${classData.name} (Term: ${classData.term})`);

  const allCRNs = [
    ...classData.class_sections.filter((s) => s.sis_crn !== null).map((s) => s.sis_crn!),
    ...classData.lab_sections.filter((s) => s.sis_crn !== null).map((s) => s.sis_crn!)
  ];

  console.log(`📋 Found ${allCRNs.length} CRNs to sync: ${allCRNs.join(", ")}`);

  // Use the exported syncSISClasses function
  const supabase = createAdminClient();
  const mockScope = createMockScope();

  try {
    const result = await syncSISClasses(supabase, classId, mockScope);
    console.log(`✅ Class sync completed: ${result.message}`);
    console.log(`   📊 Synced: ${result.synced} classes`);
    console.log(`   ❌ Errors: ${result.errors}`);
  } catch (error) {
    console.error(`❌ Class sync failed: ${error}`);
    throw error;
  }
}

/**
 * Debug why a student is not getting enrolled in new sections
 */
async function debugStudentEnrollment(classId: number, sisUserId: number): Promise<void> {
  console.log(`🔍 Debugging student enrollment for SIS User ID ${sisUserId} in class ${classId}...`);

  const supabase = createAdminClient();

  // Get class info
  const classData = await getClassInfo(classId);
  console.log(`📚 Class: ${classData.name} (Term: ${classData.term})`);

  // Check if user exists in Pawtograder
  const { data: user } = await supabase
    .from("users")
    .select("user_id, sis_user_id, email, name")
    .eq("sis_user_id", sisUserId)
    .single();

  if (!user) {
    console.log(`❌ User ${sisUserId} does not exist in Pawtograder`);
    return;
  }

  console.log(`👤 User found: ${user.name} (${user.email})`);
  console.log(`   User ID: ${user.user_id}`);

  // Check current user_roles in this class
  const { data: userRoles } = await supabase
    .from("user_roles")
    .select(
      `
      id, role, disabled, class_section_id, lab_section_id, canvas_id
    `
    )
    .eq("user_id", user.user_id)
    .eq("class_id", classId);

  console.log(`\n📋 Current user_roles in this class:`);
  if (!userRoles || userRoles.length === 0) {
    console.log(`   ❌ No user_roles found`);
  } else {
    userRoles.forEach((role, index) => {
      console.log(`   ${index + 1}. Role: ${role.role}, Disabled: ${role.disabled}`);
      console.log(`      Class Section: ${role.class_section_id}, Lab Section: ${role.lab_section_id}`);
      console.log(`      Canvas ID: ${role.canvas_id}`);
    });
  }

  // Check pending invitations
  const { data: invitations } = await supabase
    .from("invitations")
    .select("id, role, status, class_section_id, lab_section_id, sis_managed, created_at")
    .eq("sis_user_id", sisUserId)
    .eq("class_id", classId);

  console.log(`\n📬 Invitations for this user in this class:`);
  if (!invitations || invitations.length === 0) {
    console.log(`   ❌ No invitations found`);
  } else {
    invitations.forEach((inv, index) => {
      console.log(`   ${index + 1}. Role: ${inv.role}, Status: ${inv.status}, SIS Managed: ${inv.sis_managed}`);
      console.log(`      Class Section: ${inv.class_section_id}, Lab Section: ${inv.lab_section_id}`);
      console.log(`      Created: ${inv.created_at}`);
    });
  }

  // Get all CRNs and their section mappings for this class
  const allCRNs = [
    ...classData.class_sections
      .filter((s) => s.sis_crn !== null)
      .map((s) => ({
        crn: s.sis_crn!,
        sectionId: s.id,
        type: "class" as const
      })),
    ...classData.lab_sections
      .filter((s) => s.sis_crn !== null)
      .map((s) => ({
        crn: s.sis_crn!,
        sectionId: s.id,
        type: "lab" as const
      }))
  ];

  console.log(`\n🔍 Checking SIS data for CRNs: ${allCRNs.map((c) => `${c.crn}(${c.type})`).join(", ")}`);

  const sisEnrollments: Array<{
    crn: number;
    sectionType: "class" | "lab";
    sectionId: number;
    role: "instructor" | "grader" | "student";
    name: string;
  }> = [];

  for (const { crn, sectionId, type } of allCRNs) {
    try {
      const roster = await fetchSISRoster(crn, (classData.term || 0).toString());
      if (!roster) {
        console.log(`   ⚠️  No roster data for CRN ${crn}`);
        continue;
      }

      // Check if user is in this CRN's roster
      const instructorMatch = roster.instructors.find((u) => u.nuid === sisUserId);
      const taMatch = roster.tas.find((u) => u.nuid === sisUserId);
      const studentMatch = roster.students.find((u) => Number(u.nuid) === sisUserId);

      if (instructorMatch) {
        sisEnrollments.push({
          crn,
          sectionType: type,
          sectionId,
          role: "instructor",
          name: `${instructorMatch.first_name} ${instructorMatch.last_name}`
        });
        console.log(`   ✅ Found as INSTRUCTOR in CRN ${crn} (${type} section)`);
      }

      if (taMatch) {
        sisEnrollments.push({
          crn,
          sectionType: type,
          sectionId,
          role: "grader",
          name: `${taMatch.first_name} ${taMatch.last_name}`
        });
        console.log(`   ✅ Found as GRADER in CRN ${crn} (${type} section)`);
      }

      if (studentMatch) {
        sisEnrollments.push({
          crn,
          sectionType: type,
          sectionId,
          role: "student",
          name: `${studentMatch.first_name} ${studentMatch.last_name}`
        });
        console.log(`   ✅ Found as STUDENT in CRN ${crn} (${type} section)`);
      }

      if (!instructorMatch && !taMatch && !studentMatch) {
        console.log(`   ❌ Not found in CRN ${crn} (${type} section)`);
      }
    } catch (error) {
      console.error(`   ❌ Error checking CRN ${crn}: ${error}`);
    }
  }

  if (sisEnrollments.length === 0) {
    console.log(`\n❌ User ${sisUserId} not found in any SIS rosters for this class`);
  } else {
    console.log(`\n📊 SIS Enrollment Summary:`);
    sisEnrollments.forEach((enrollment, index) => {
      console.log(
        `   ${index + 1}. ${enrollment.role.toUpperCase()} in CRN ${enrollment.crn} (${enrollment.sectionType} section)`
      );
      console.log(`      Section ID: ${enrollment.sectionId}, Name: ${enrollment.name}`);
    });
  }

  // Analyze the gap between SIS and Pawtograder
  console.log(`\n🔍 GAP ANALYSIS:`);

  // Check if user has ANY user role in class (this is what blocks new invitations)
  const hasAnyUserRole = userRoles && userRoles.some((r) => !r.disabled);
  console.log(`   • Has ANY active user_role in class: ${hasAnyUserRole ? "✅ YES" : "❌ NO"}`);

  if (hasAnyUserRole) {
    console.log(`   🚨 ISSUE: User has existing user_role, so sync skips creating new invitations`);
    console.log(`   🔧 SOLUTION: Sync should UPDATE existing user_roles instead of only creating invitations`);

    // Show what sections they should be in vs what they are in
    const currentClassSections = new Set(
      userRoles?.filter((r) => r.class_section_id).map((r) => r.class_section_id) || []
    );
    const currentLabSections = new Set(userRoles?.filter((r) => r.lab_section_id).map((r) => r.lab_section_id) || []);

    const sisClassSections = new Set(sisEnrollments.filter((e) => e.sectionType === "class").map((e) => e.sectionId));
    const sisLabSections = new Set(sisEnrollments.filter((e) => e.sectionType === "lab").map((e) => e.sectionId));

    console.log(`\n   📋 SECTION COMPARISON:`);
    console.log(`   Current Class Sections: [${Array.from(currentClassSections).join(", ") || "none"}]`);
    console.log(`   SIS Class Sections:     [${Array.from(sisClassSections).join(", ") || "none"}]`);
    console.log(`   Current Lab Sections:   [${Array.from(currentLabSections).join(", ") || "none"}]`);
    console.log(`   SIS Lab Sections:       [${Array.from(sisLabSections).join(", ") || "none"}]`);

    // Find missing sections
    const missingClassSections = Array.from(sisClassSections).filter((s) => !currentClassSections.has(s));
    const missingLabSections = Array.from(sisLabSections).filter((s) => !currentLabSections.has(s));

    if (missingClassSections.length > 0 || missingLabSections.length > 0) {
      console.log(`\n   🚨 MISSING SECTIONS:`);
      if (missingClassSections.length > 0) {
        console.log(`      Missing Class Sections: [${missingClassSections.join(", ")}]`);
      }
      if (missingLabSections.length > 0) {
        console.log(`      Missing Lab Sections: [${missingLabSections.join(", ")}]`);
      }
    }
  }

  // Check for pending invitations that might address the gap
  const pendingInvitations = invitations?.filter((i) => i.status === "pending") || [];
  if (pendingInvitations.length > 0) {
    console.log(`\n   📬 Pending invitations might resolve some gaps`);
  }

  console.log(`\n📋 FINAL SUMMARY for user ${sisUserId}:`);
  console.log(`   • Exists in Pawtograder: ${user ? "✅" : "❌"}`);
  console.log(`   • Has user_role in class: ${hasAnyUserRole ? "✅" : "❌"}`);
  console.log(`   • Has pending invitations: ${pendingInvitations.length > 0 ? "✅" : "❌"}`);
  console.log(`   • Found in SIS rosters: ${sisEnrollments.length > 0 ? "✅" : "❌"}`);
  console.log(`   • SIS sections: ${sisEnrollments.length}`);
  console.log(`   • Current user_roles: ${userRoles?.length || 0}`);

  // If this user should get invitations but doesn't have any, suggest running sync
  if (!hasAnyUserRole && pendingInvitations.length === 0 && sisEnrollments.length > 0) {
    console.log(`\n🔧 SUGGESTED ACTION:`);
    console.log(`   This user should receive invitations but has none.`);
    console.log(`   Try running: deno run --allow-all manualSync.ts sync-class ${classId}`);
    console.log(`   This will trigger the full SIS sync process for this class.`);
  }
}

/**
 * Test SIS API connectivity
 */
async function testSISAPI(term: string, courseCode: string): Promise<void> {
  console.log(`🧪 Testing SIS API connectivity...`);
  console.log(`   Term: ${term}`);
  console.log(`   Course Code: ${courseCode}`);

  try {
    // Test CRN endpoint
    console.log(`🔍 Testing CRN endpoint...`);
    const crns = await fetchSISCRNs(courseCode, term);
    console.log(`✅ CRN endpoint working. Found ${crns.length} sections: ${crns.join(", ")}`);

    if (crns.length > 0) {
      // Test roster endpoint with first CRN
      const testCRN = crns[0];
      console.log(`🔍 Testing roster endpoint with CRN ${testCRN}...`);
      const roster = await fetchSISRoster(testCRN, term);

      if (roster) {
        console.log(`✅ Roster endpoint working for CRN ${testCRN}:`);
        console.log(`   👨‍🏫 Instructors: ${roster.instructors.length}`);
        console.log(`   👨‍💼 TAs: ${roster.tas.length}`);
        console.log(`   👨‍🎓 Students: ${roster.students.length}`);
        console.log(`   📚 Course: ${roster.section_meta.course} - ${roster.section_meta.title}`);
      } else {
        console.log(`❌ No roster data returned for CRN ${testCRN}`);
      }
    }

    console.log(`✅ SIS API connectivity test completed successfully`);
  } catch (error) {
    console.error(`❌ SIS API test failed: ${error}`);
    throw error;
  }
}

// Command Line Interface

async function main() {
  try {
    Config.validate();

    const args = Deno.args;
    if (args.length === 0) {
      console.log(`
📋 Manual SIS Sync Script

Usage:
  deno run --allow-net --allow-env --allow-read --allow-write manualSync.ts <command> [options]

Commands:
  list-roster <classId>              - List complete roster for a Pawtograder class
  export-csv <classId> <filename>    - Export roster to CSV file
  sync-crn <crn> <term>             - Manually sync a single CRN
  sync-class <classId>              - Manually sync all CRNs for a class
  debug-student <classId> <sisUserId> - Debug why a student isn't enrolled properly
  test-sis-api <term> <courseCode>  - Test SIS API connectivity

Examples:
  deno run --allow-all manualSync.ts list-roster 123
  deno run --allow-all manualSync.ts export-csv 123 roster.csv
  deno run --allow-all manualSync.ts sync-crn 12345 202430
  deno run --allow-all manualSync.ts sync-class 123
  deno run --allow-all manualSync.ts debug-student 123 123456789
  deno run --allow-all manualSync.ts test-sis-api 202430 CS2500
      `);
      return;
    }

    const command = args[0];

    switch (command) {
      case "list-roster": {
        if (args.length < 2) {
          throw new Error("Usage: list-roster <classId>");
        }
        const classId = parseInt(args[1]);
        if (isNaN(classId)) {
          throw new Error("classId must be a number");
        }

        const roster = await getCompleteRoster(classId);

        console.log(`\n📋 Complete Roster:`);
        console.log(`${"=".repeat(80)}`);

        let currentRole = "";
        for (const entry of roster) {
          if (entry.role !== currentRole) {
            currentRole = entry.role;
            console.log(`\n${currentRole.toUpperCase()}S:`);
          }

          const sections = [];
          if (entry.courseCRN) sections.push(`Class: ${entry.courseCRN} (${entry.courseSectionName})`);
          if (entry.labCRN) sections.push(`Lab: ${entry.labCRN} (${entry.labSectionName})`);

          console.log(`  ${entry.fullName} (${entry.sisUserId}) - ${sections.join(", ") || "No sections"}`);
        }
        break;
      }

      case "export-csv": {
        if (args.length < 3) {
          throw new Error("Usage: export-csv <classId> <filename>");
        }
        const classId = parseInt(args[1]);
        const filename = args[2];

        if (isNaN(classId)) {
          throw new Error("classId must be a number");
        }

        const roster = await getCompleteRoster(classId);
        await exportRosterToCSV(roster, filename);
        break;
      }

      case "sync-crn": {
        if (args.length < 3) {
          throw new Error("Usage: sync-crn <crn> <term>");
        }
        const crn = parseInt(args[1]);
        const term = args[2];

        if (isNaN(crn)) {
          throw new Error("CRN must be a number");
        }

        await syncSingleCRN(crn, term);
        break;
      }

      case "sync-class": {
        if (args.length < 2) {
          throw new Error("Usage: sync-class <classId>");
        }
        const classId = parseInt(args[1]);

        if (isNaN(classId)) {
          throw new Error("classId must be a number");
        }

        await syncClass(classId);
        break;
      }

      case "debug-student": {
        if (args.length < 3) {
          throw new Error("Usage: debug-student <classId> <sisUserId>");
        }
        const classId = parseInt(args[1]);
        const sisUserId = parseInt(args[2]);

        if (isNaN(classId)) {
          throw new Error("classId must be a number");
        }
        if (isNaN(sisUserId)) {
          throw new Error("sisUserId must be a number");
        }

        await debugStudentEnrollment(classId, sisUserId);
        break;
      }

      case "test-sis-api": {
        if (args.length < 3) {
          throw new Error("Usage: test-sis-api <term> <courseCode>");
        }
        const term = args[1];
        const courseCode = args[2];

        await testSISAPI(term, courseCode);
        break;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
