"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { VStack, HStack, Text, Heading, Card, Badge, Table, Box, Flex, Grid } from "@chakra-ui/react";

import { Checkbox } from "@chakra-ui/react";
import { Download, Users, GraduationCap, BookOpen, MapPin, Clock, AlertCircle } from "lucide-react";
import { courseImportSis, invitationCreate } from "@/lib/edgeFunctions";
import * as FunctionTypes from "@/supabase/functions/_shared/FunctionTypes.js";
import { TermSelector } from "@/components/ui/term-selector";

// Use shared types
type CourseImportData = FunctionTypes.CourseImportResponse;

type ExistingClass = {
  id: number;
  name: string;
  term: number;
  course_title: string;
  description: string | null;
  student_count: number;
  instructor_count: number;
  grader_count: number;
  pending_students: number;
  pending_instructors: number;
  pending_graders: number;
  class_sections_count: number;
  lab_sections_count: number;
  total_sections: number;
  created_at: string;
};

type ExistingSection = {
  id: number;
  name: string;
  sis_crn: number;
  section_type: "class" | "lab";
  member_count: number;
};

type ImportSummary = {
  classCreated: boolean;
  classId?: number;
  sectionsCreated: number;
  invitationsSent: number;
  errors: string[];
};

export default function CourseImportPage() {
  const [semester, setSemester] = useState(202610);
  const [mainCourseCode, setMainCourseCode] = useState("");
  const [labCourseCode, setLabCourseCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [importData, setImportData] = useState<CourseImportData | null>(null);
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const [existingClass, setExistingClass] = useState<ExistingClass | null>(null);
  const [existingSections, setExistingSections] = useState<ExistingSection[]>([]);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [existingClassesForTerm, setExistingClassesForTerm] = useState<
    Array<{ id: number; name: string | null; course_title: string | null }>
  >([]);
  const [selectedExistingClassId, setSelectedExistingClassId] = useState<number | null>(null);
  const [invitationProgress, setInvitationProgress] = useState<{
    current: number;
    total: number;
    currentBatch: number;
    totalBatches: number;
    isProcessing: boolean;
  } | null>(null);

  const supabase = useMemo(() => createClient(), []);

  /**
   * Helper function to get all records from a paginated Supabase query.
   * Supabase limits results to 25 rows by default, with max 1000 per page.
   * This function handles pagination automatically to get all results.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getAllRecords<T>(queryBuilder: any, pageSize = 1000): Promise<T[]> {
    const allRecords: T[] = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      // Use range() to specify which page of results to get
      const { data, error } = await queryBuilder.range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        throw error;
      }

      if (data && data.length > 0) {
        allRecords.push(...data);
        // If we got a full page, there might be more records
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    }

    return allRecords;
  }

  // Helper function to process invitations in batches to avoid timeouts
  const processBatchedInvitations = useCallback(
    async (
      classId: number,
      allInvitations: Array<{
        sis_user_id: string;
        role: "instructor" | "grader" | "student";
        name?: string;
        class_section_id?: number;
        lab_section_id?: number;
      }>
    ) => {
      const BATCH_SIZE = 50;
      const batches = [];

      // Split invitations into batches
      for (let i = 0; i < allInvitations.length; i += BATCH_SIZE) {
        batches.push(allInvitations.slice(i, i + BATCH_SIZE));
      }

      let totalInvitationsSent = 0;
      const allErrors: string[] = [];

      // Initialize progress
      setInvitationProgress({
        current: 0,
        total: allInvitations.length,
        currentBatch: 0,
        totalBatches: batches.length,
        isProcessing: true
      });

      // Process each batch
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];

        try {
          // Update progress
          setInvitationProgress((prev) =>
            prev
              ? {
                  ...prev,
                  currentBatch: batchIndex + 1,
                  current: Math.min(totalInvitationsSent + batch.length, allInvitations.length)
                }
              : null
          );

          const response = await invitationCreate(
            {
              courseId: classId,
              invitations: batch
            },
            supabase
          );

          if (response.success) {
            totalInvitationsSent += response.invitations.length;
            if (response.errors && response.errors.length > 0) {
              response.errors.forEach((err) => {
                allErrors.push(`Batch ${batchIndex + 1} - ${err.sis_user_id}: ${err.error}`);
              });
            }
          } else {
            allErrors.push(`Batch ${batchIndex + 1} failed to process`);
          }

          // Small delay between batches to prevent overwhelming the server
          if (batchIndex < batches.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (error) {
          allErrors.push(`Batch ${batchIndex + 1} error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }

        // Update progress
        setInvitationProgress((prev) =>
          prev
            ? {
                ...prev,
                current: Math.min(totalInvitationsSent, allInvitations.length)
              }
            : null
        );
      }

      // Clear progress
      setInvitationProgress(null);

      return {
        invitationsSent: totalInvitationsSent,
        errors: allErrors
      };
    },
    [supabase]
  );

  // Find all existing classes for a term
  const findExistingClassesForTerm = useCallback(
    async (term: number) => {
      try {
        const { data, error } = await supabase
          .from("classes")
          .select(
            `
          id,
          name,
          term,
          course_title,
          description,
          created_at
        `
          )
          .eq("term", term)
          .eq("archived", false)
          .order("course_title", { ascending: true });

        if (error) {
          console.error("Error fetching existing classes:", error);
          return [];
        }

        return data || [];
      } catch (error) {
        console.error("Error fetching existing classes:", error);
        return [];
      }
    },
    [supabase]
  );

  // Find existing class with same title and term
  const findExistingClass = useCallback(
    async (class_id: number) => {
      try {
        const { data, error } = await supabase
          .from("classes")
          .select(
            `
          id,
          name,
          term,
          course_title,
          description,
          created_at
        `
          )
          .eq("id", class_id)
          .eq("archived", false)
          .single();

        if (error && error.code !== "PGRST116") {
          // PGRST116 is "no rows found"
          return null;
        }

        if (data) {
          // Get enrolled user counts by getting all user roles with pagination
          const studentRoles = await getAllRecords<{ id: string }>(
            supabase.from("user_roles").select("id").eq("class_id", data.id).eq("role", "student")
          );

          const instructorRoles = await getAllRecords<{ id: string }>(
            supabase.from("user_roles").select("id").eq("class_id", data.id).eq("role", "instructor")
          );

          const graderRoles = await getAllRecords<{ id: string }>(
            supabase.from("user_roles").select("id").eq("class_id", data.id).eq("role", "grader")
          );

          // Get pending invitation counts
          const pendingInvitations = await getAllRecords<{ id: number; role: string }>(
            supabase.from("invitations").select("id, role").eq("class_id", data.id).eq("status", "pending")
          );

          const pendingStudents = pendingInvitations.filter((inv) => inv.role === "student").length;
          const pendingInstructors = pendingInvitations.filter((inv) => inv.role === "instructor").length;
          const pendingGraders = pendingInvitations.filter((inv) => inv.role === "grader").length;

          // Get section counts
          const classSections = await getAllRecords<{ id: number }>(
            supabase.from("class_sections").select("id").eq("class_id", data.id)
          );

          const labSections = await getAllRecords<{ id: number }>(
            supabase.from("lab_sections").select("id").eq("class_id", data.id)
          );

          return {
            ...data,
            student_count: studentRoles.length,
            instructor_count: instructorRoles.length,
            grader_count: graderRoles.length,
            pending_students: pendingStudents,
            pending_instructors: pendingInstructors,
            pending_graders: pendingGraders,
            class_sections_count: classSections.length,
            lab_sections_count: labSections.length,
            total_sections: classSections.length + labSections.length
          } as ExistingClass;
        }

        return null;
      } catch {
        return null;
      }
    },
    [supabase]
  );

  // Fetch existing classes when component mounts
  useEffect(() => {
    if (semester) {
      findExistingClassesForTerm(semester).then((classes) => {
        const validClasses = classes.filter((c) => c.name || c.course_title);
        setExistingClassesForTerm(validClasses);
      });
    }
  }, [semester, findExistingClassesForTerm]);

  // Find existing sections by CRN
  const findExistingSections = useCallback(
    async (classId: number, crns: number[]) => {
      if (crns.length === 0) return [];

      try {
        // Check class sections with pagination
        const classSections = await getAllRecords<{ id: number; name: string | null; sis_crn: number | null }>(
          supabase.from("class_sections").select("id, name, sis_crn").eq("class_id", classId).in("sis_crn", crns)
        );

        // Check lab sections with pagination
        const labSections = await getAllRecords<{ id: number; name: string | null; sis_crn: number | null }>(
          supabase.from("lab_sections").select("id, name, sis_crn").eq("class_id", classId).in("sis_crn", crns)
        );

        const existingSections: ExistingSection[] = [];

        // Process class sections
        if (classSections && classSections.length > 0) {
          for (const section of classSections) {
            if (section.sis_crn) {
              // Get member count with pagination
              const members = await getAllRecords<{ id: string }>(
                supabase.from("user_roles").select("id").eq("class_section_id", section.id)
              );

              existingSections.push({
                id: section.id,
                name: section.name || "",
                sis_crn: section.sis_crn,
                section_type: "class",
                member_count: members.length
              });
            }
          }
        }

        // Process lab sections
        if (labSections && labSections.length > 0) {
          for (const section of labSections) {
            if (section.sis_crn) {
              // Get member count with pagination
              const members = await getAllRecords<{ id: string }>(
                supabase.from("user_roles").select("id").eq("lab_section_id", section.id)
              );

              existingSections.push({
                id: section.id,
                name: section.name || "",
                sis_crn: section.sis_crn,
                section_type: "lab",
                member_count: members.length
              });
            }
          }
        }

        return existingSections;
      } catch {
        return [];
      }
    },
    [supabase]
  );

  const formatInstructorName = (fullName: string) => {
    const parts = fullName.split(" ");
    if (parts.length > 1) {
      const lastName = parts[parts.length - 1];
      const firstInitial = parts[0].charAt(0);
      return `${lastName}, ${firstInitial}`;
    }
    return fullName;
  };

  // Fetch existing classes when term changes
  const handleTermChange = useCallback(
    async (newTerm: number) => {
      setSemester(newTerm);
      setSelectedExistingClassId(null);
      setExistingClass(null);

      // Fetch existing classes for the new term
      const classes = await findExistingClassesForTerm(newTerm);
      // Filter out classes with null names or course titles
      const validClasses = classes.filter((c) => c.name && c.course_title);
      setExistingClassesForTerm(validClasses);
    },
    [findExistingClassesForTerm]
  );

  const handleImport = useCallback(async () => {
    if (!semester || !mainCourseCode.trim()) {
      toaster.create({
        title: "Validation Error",
        description: "Semester and main course code are required",
        type: "error"
      });
      return;
    }

    setIsLoading(true);
    // Reset previous state
    setExistingClass(null);
    setExistingSections([]);
    setImportSummary(null);
    setInvitationProgress(null);

    try {
      const response = await courseImportSis(
        {
          term: semester.toString(),
          mainCourseCode: mainCourseCode.trim().toUpperCase(),
          labCourseCode: labCourseCode.trim().toUpperCase() || "",
          existingClassId: selectedExistingClassId || undefined
        },
        supabase
      );

      const result = response;

      if (!result.success) {
        throw new Error("Import failed");
      }

      setImportData(result);
      // Select all sections by default
      setSelectedSections(new Set(result.sections.map((s) => s.crn)));

      // If existingClassId was provided and validated, use that class
      let existingClassResult: ExistingClass | null = null;
      if (result.existingClassId) {
        existingClassResult = await findExistingClass(result.existingClassId);
        setExistingClass(existingClassResult);
        setSelectedExistingClassId(result.existingClassId);
      }

      // If there's an existing class, check for existing sections
      if (existingClassResult) {
        const crns = result.sections.map((s) => s.crn);
        const existingSectionsResult = await findExistingSections(existingClassResult.id, crns);
        setExistingSections(existingSectionsResult);
      }

      toaster.create({
        title: "Import Successful",
        description: `Found ${result.sections.length} sections. ${result.enrollmentStatus.students.newInvitations} new student invitations will be created.`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Import Error",
        description: error instanceof Error ? error.message : "Failed to import course data",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    semester,
    mainCourseCode,
    labCourseCode,
    selectedExistingClassId,
    supabase,
    findExistingClass,
    findExistingSections
  ]);

  const handleCreateClass = useCallback(async () => {
    if (!importData) return;

    const selectedSectionData = importData.sections.filter((s) => selectedSections.has(s.crn));
    if (selectedSectionData.length === 0) {
      toaster.create({
        title: "No Sections Selected",
        description: "Please select at least one section to import",
        type: "error"
      });
      return;
    }

    setIsCreating(true);
    const summary: ImportSummary = {
      classCreated: false,
      sectionsCreated: 0,
      invitationsSent: 0,
      errors: []
    };

    try {
      let classId: number;

      if (selectedExistingClassId) {
        // Use existing class
        classId = selectedExistingClassId;
        summary.classCreated = false; // Not creating, just syncing
        summary.classId = classId;
      } else {
        // Extract year and term from semester code (e.g., 202610 -> Fall 2026)
        let year = Math.floor(semester / 100);
        const termCode = semester % 100;
        const termMap: { [key: number]: string } = {
          10: "fa",
          20: "sp",
          30: "su1",
          40: "su2"
        };
        if (termCode === 10) {
          //Apparently Banner made the brilliant decision that Fall is the next year so it sorts right.
          year = year - 1;
        }
        const lastTwoDigits = year % 100;

        // Create the class
        const { data: newClassId, error: classError } = await supabase.rpc("admin_create_class", {
          p_name: importData.courseInfo.course,
          p_term: semester,
          p_description: `${importData.courseInfo.title}`,
          p_course_title: importData.courseInfo.title,
          p_start_date: importData.courseInfo.startDate,
          p_end_date: importData.courseInfo.endDate,
          p_github_template_prefix: `${termMap[termCode]}${lastTwoDigits}`
        });

        if (classError) throw classError;

        classId = newClassId;
        summary.classCreated = true;
        summary.classId = classId;
      }

      // Create sections and collect all users for invitations
      const classSections = selectedSectionData.filter((s) => s.sectionType === "class");
      const labSections = selectedSectionData.filter((s) => s.sectionType === "lab");

      const allInvitations: Array<{
        sis_user_id: string;
        role: "instructor" | "grader" | "student";
        name?: string;
        class_section_id?: number;
        lab_section_id?: number;
      }> = [];

      // Create class sections
      for (const section of classSections) {
        const { data: sectionId, error: sectionError } = await supabase.rpc("admin_create_class_section", {
          p_class_id: classId,
          p_name: section.sectionName,
          p_meeting_location: section.location,
          p_meeting_times: section.meetingInfo,
          p_campus: importData.courseInfo.campus,
          p_sis_crn: section.crn
        });

        if (sectionError) {
          summary.errors.push(`Failed to create class section ${section.sectionName}: ${sectionError.message}`);
          continue;
        }

        summary.sectionsCreated++;

        // Add users from this section
        [...section.instructors, ...section.tas, ...section.students].forEach((user) => {
          allInvitations.push({
            sis_user_id: user.sis_user_id.toString(),
            role: user.role,
            name: user.name,
            class_section_id: sectionId
          });
        });
      }

      // Create lab sections
      for (const section of labSections) {
        if (
          !section.parsedMeetingTimes ||
          !section.parsedMeetingTimes.dayOfWeek ||
          !section.parsedMeetingTimes.startTime ||
          !section.parsedMeetingTimes.endTime
        ) {
          summary.errors.push(`Failed to create lab section ${section.sectionName}: No meeting times`);
          continue;
        }
        const createLabParams = {
          p_class_id: classId,
          p_name: section.sectionName,
          p_meeting_location: section.location,
          p_meeting_times: section.meetingInfo,
          p_campus: importData.courseInfo.campus,
          p_sis_crn: section.crn,
          p_description: `CRN ${section.crn}`,
          p_start_time: section.parsedMeetingTimes.startTime,
          p_end_time: section.parsedMeetingTimes.endTime,
          p_day_of_week: section.parsedMeetingTimes.dayOfWeek
        };

        const { data: sectionId, error: sectionError } = await supabase.rpc(
          "admin_create_lab_section",
          createLabParams
        );

        if (sectionError) {
          summary.errors.push(`Failed to create lab section ${section.sectionName}: ${sectionError.message}`);
          continue;
        }

        summary.sectionsCreated++;

        // Add users from this section
        [...section.instructors, ...section.tas, ...section.students].forEach((user) => {
          allInvitations.push({
            sis_user_id: user.sis_user_id.toString(),
            role: user.role,
            name: user.name,
            lab_section_id: sectionId
          });
        });
      }

      // Deduplicate invitations by sis_user_id (take highest role if duplicates)
      const invitationMap = new Map<string, (typeof allInvitations)[0]>();
      const roleHierarchy = { instructor: 3, grader: 2, student: 1 };

      allInvitations.forEach((inv) => {
        const existing = invitationMap.get(inv.sis_user_id);
        if (!existing || roleHierarchy[inv.role] > roleHierarchy[existing.role]) {
          invitationMap.set(inv.sis_user_id, inv);
        }
      });

      // Create bulk invitations in batches
      const uniqueInvitations = Array.from(invitationMap.values());
      if (uniqueInvitations.length > 0) {
        const batchResult = await processBatchedInvitations(classId, uniqueInvitations);

        summary.invitationsSent = batchResult.invitationsSent;
        if (batchResult.errors.length > 0) {
          summary.errors.push(...batchResult.errors);
        }
      }

      // Set the summary for display
      setImportSummary(summary);

      toaster.create({
        title: selectedExistingClassId ? "Class Synced Successfully" : "Class Created Successfully",
        description: `${selectedExistingClassId ? "Synced" : "Created"} class with ${summary.sectionsCreated} sections and ${summary.invitationsSent} invitations sent`,
        type: "success"
      });

      // Reset form
      setImportData(null);
      setSemester(202610);
      setMainCourseCode("");
      setLabCourseCode("");
      setSelectedSections(new Set());
      setExistingClass(null);
      setExistingSections([]);
      setInvitationProgress(null);
    } catch (error) {
      summary.errors.push(error instanceof Error ? error.message : "Unknown error occurred");
      setImportSummary(summary);

      toaster.create({
        title: "Creation Error",
        description: error instanceof Error ? error.message : "Failed to create class",
        type: "error"
      });
    } finally {
      setIsCreating(false);
      setInvitationProgress(null); // Make sure to clear progress on error
    }
  }, [importData, selectedSections, selectedExistingClassId, supabase, processBatchedInvitations, semester]);

  const toggleSection = (crn: number) => {
    const newSelected = new Set(selectedSections);
    if (newSelected.has(crn)) {
      newSelected.delete(crn);
    } else {
      newSelected.add(crn);
    }
    setSelectedSections(newSelected);
  };

  const toggleAllSections = () => {
    if (!importData) return;

    if (selectedSections.size === importData.sections.length) {
      setSelectedSections(new Set());
    } else {
      setSelectedSections(new Set(importData.sections.map((s) => s.crn)));
    }
  };

  const getSectionStatus = (crn: number) => {
    const existingSection = existingSections.find((s) => s.sis_crn === crn);
    if (existingSection) {
      return {
        status: "existing",
        badge: "Already Imported",
        color: "green",
        memberCount: existingSection.member_count
      } as const;
    }
    return {
      status: "new",
      badge: "New Section",
      color: "blue",
      memberCount: null
    } as const;
  };

  // Helper function to analyze what will be created vs what exists
  const getCreationAnalysis = () => {
    if (!importData) return null;

    const selectedSectionData = importData.sections.filter((s) => selectedSections.has(s.crn));

    // Section analysis
    const selectedClassSections = selectedSectionData.filter((s) => s.sectionType === "class");
    const selectedLabSections = selectedSectionData.filter((s) => s.sectionType === "lab");

    const existingClassSections = selectedClassSections.filter((s) =>
      existingSections.some((ex) => ex.sis_crn === s.crn && ex.section_type === "class")
    );
    const existingLabSections = selectedLabSections.filter((s) =>
      existingSections.some((ex) => ex.sis_crn === s.crn && ex.section_type === "lab")
    );

    const newClassSections = selectedClassSections.length - existingClassSections.length;
    const newLabSections = selectedLabSections.length - existingLabSections.length;

    // User analysis - get all unique users from selected sections
    const allUsers = new Set(
      selectedSectionData.flatMap((s) => [...s.instructors, ...s.tas, ...s.students]).map((u) => u.sis_user_id)
    );

    // If existing class, calculate how many users are already enrolled
    let existingUsers = 0;
    if (selectedExistingClassId) {
      // Find the selected existing class to get user counts
      const selectedClass = existingClassesForTerm.find((c) => c.id === selectedExistingClassId);
      if (selectedClass) {
        // For now, we'll estimate existing users based on the existing class
        // In a real implementation, you might want to fetch actual user counts
        existingUsers = 0; // This will be updated when we implement the actual sync
      }
    }

    // Rough estimate of new invitations (this is approximate since we'd need to check each user individually)
    const estimatedNewInvitations = Math.max(0, allUsers.size - existingUsers);

    return {
      classExists: !!selectedExistingClassId,
      classSections: {
        total: selectedClassSections.length,
        existing: existingClassSections.length,
        new: newClassSections
      },
      labSections: {
        total: selectedLabSections.length,
        existing: existingLabSections.length,
        new: newLabSections
      },
      users: {
        total: allUsers.size,
        existing: existingUsers,
        newInvitations: estimatedNewInvitations
      }
    };
  };

  return (
    <VStack align="stretch" gap={6} maxW="6xl" mx="auto">
      {/* Header */}
      <VStack align="start" gap={2}>
        <Heading size="2xl">Course Import from SIS</Heading>
        <Text color="fg.muted">Import course sections and create invitations for all enrolled users</Text>
      </VStack>

      {/* Import Form */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Import Course Data</Card.Title>
          <Text color="fg.muted">Enter semester and course codes to fetch enrollment data from SIS</Text>
        </Card.Header>
        <Card.Body>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleImport();
            }}
          >
            <VStack gap={4}>
              <HStack gap={4} w="full">
                <VStack align="start" flex={1}>
                  <Label htmlFor="semester">Term *</Label>
                  <TermSelector value={semester} onChange={handleTermChange} label="Semester" required />
                  <Text fontSize="xs" color="fg.subtle">
                    Banner format: YYYYTT (e.g., 202610 = Fall 2025)
                  </Text>
                </VStack>
                <VStack align="start" flex={1}>
                  <Label htmlFor="mainCourse">Main Course Code *</Label>
                  <Input
                    id="mainCourse"
                    value={mainCourseCode}
                    onChange={(e) => setMainCourseCode(e.target.value.toUpperCase())}
                    placeholder="e.g., CS2500"
                  />
                  <Text fontSize="xs" color="fg.subtle">
                    Source of class sections
                  </Text>
                </VStack>
                <VStack align="start" flex={1}>
                  <Label htmlFor="labCourse">Lab Course Code</Label>
                  <Input
                    id="labCourse"
                    value={labCourseCode}
                    onChange={(e) => setLabCourseCode(e.target.value.toUpperCase())}
                    placeholder="e.g., CS2501 (optional)"
                  />
                  <Text fontSize="xs" color="fg.subtle">
                    Source of lab sections (optional)
                  </Text>
                </VStack>
              </HStack>

              {/* Existing Class Selector */}
              {existingClassesForTerm.length > 0 && (
                <HStack gap={4} w="full">
                  <VStack align="start" flex={1}>
                    <Label htmlFor="existingClass">Use Existing Class (Optional)</Label>
                    <select
                      value={selectedExistingClassId || ""}
                      onChange={(e) => setSelectedExistingClassId(e.target.value ? parseInt(e.target.value) : null)}
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        border: "1px solid #e2e8f0",
                        borderRadius: "6px",
                        fontSize: "14px"
                      }}
                    >
                      <option value="">Select an existing class to sync to...</option>
                      {existingClassesForTerm.map((cls) => (
                        <option key={cls.id} value={cls.id}>
                          {cls.course_title} - {cls.name}
                        </option>
                      ))}
                    </select>
                    <Text fontSize="xs" color="fg.subtle">
                      If selected, sections will be added to this existing class instead of creating a new one
                    </Text>
                  </VStack>
                </HStack>
              )}

              <Button type="submit" loading={isLoading} disabled={!semester || !mainCourseCode.trim()} size="lg">
                <HStack gap={2}>
                  <Download size={20} />
                  <Text>{isLoading ? "Importing..." : "Import from SIS"}</Text>
                </HStack>
              </Button>
            </VStack>
          </form>
        </Card.Body>
      </Card.Root>

      {/* Import Results */}
      {importData && (
        <>
          {/* Course Info */}
          <Card.Root>
            <Card.Header>
              <Card.Title>Course Information</Card.Title>
            </Card.Header>
            <Card.Body>
              <Grid templateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap={4}>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Course
                  </Text>
                  <Text fontWeight="medium">{importData.courseInfo.course}</Text>
                </VStack>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Title
                  </Text>
                  <Text fontWeight="medium">{importData.courseInfo.title}</Text>
                </VStack>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Campus
                  </Text>
                  <HStack gap={1}>
                    <MapPin size={16} />
                    <Text fontWeight="medium">{importData.courseInfo.campus}</Text>
                  </HStack>
                </VStack>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Duration
                  </Text>
                  <HStack gap={1}>
                    <Clock size={16} />
                    <Text fontWeight="medium">
                      {importData.courseInfo.startDate} to {importData.courseInfo.endDate}
                    </Text>
                  </HStack>
                </VStack>
              </Grid>
            </Card.Body>
          </Card.Root>

          {/* Existing Class Information */}
          {existingClass && (
            <Card.Root>
              <Card.Header>
                <Card.Title>Existing Class Found</Card.Title>
                <Text color="orange.fg" fontSize="sm">
                  A class with the same title and term already exists. This import will sync to that class.
                </Text>
              </Card.Header>
              <Card.Body>
                <VStack gap={6}>
                  {/* Basic Info */}
                  <Grid templateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap={4}>
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                        Class Name
                      </Text>
                      <Text fontWeight="medium">{existingClass.name}</Text>
                    </VStack>
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                        Course Title
                      </Text>
                      <Text fontWeight="medium">{existingClass.course_title}</Text>
                    </VStack>
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                        Total Sections
                      </Text>
                      <HStack gap={1}>
                        <Text fontWeight="medium" color="purple.fg">
                          {existingClass.total_sections}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          ({existingClass.class_sections_count} class, {existingClass.lab_sections_count} lab)
                        </Text>
                      </HStack>
                    </VStack>
                    <VStack align="start" gap={1}>
                      <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                        Created
                      </Text>
                      <Text fontWeight="medium">{new Date(existingClass.created_at).toLocaleDateString()}</Text>
                    </VStack>
                  </Grid>

                  {/* Enrollment Status */}
                  <Box w="full">
                    <Text fontWeight="semibold" mb={4}>
                      Current Enrollment Status
                    </Text>
                    <Grid templateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap={4}>
                      {/* Students */}
                      <VStack align="center" gap={2} p={4} bg="blue.bg" rounded="md">
                        <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                          Students
                        </Text>
                        <VStack gap={1}>
                          <HStack gap={2}>
                            <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                              {existingClass.student_count}
                            </Text>
                            <Text fontSize="sm" color="fg.muted">
                              enrolled
                            </Text>
                          </HStack>
                          {existingClass.pending_students > 0 && (
                            <HStack gap={2}>
                              <Text fontSize="lg" fontWeight="semibold" color="orange.fg">
                                {existingClass.pending_students}
                              </Text>
                              <Text fontSize="sm" color="fg.muted">
                                pending
                              </Text>
                            </HStack>
                          )}
                        </VStack>
                      </VStack>

                      {/* Instructors */}
                      <VStack align="center" gap={2} p={4} bg="green.bg" rounded="md">
                        <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                          Instructors
                        </Text>
                        <VStack gap={1}>
                          <HStack gap={2}>
                            <Text fontSize="2xl" fontWeight="bold" color="green.fg">
                              {existingClass.instructor_count}
                            </Text>
                            <Text fontSize="sm" color="fg.muted">
                              enrolled
                            </Text>
                          </HStack>
                          {existingClass.pending_instructors > 0 && (
                            <HStack gap={2}>
                              <Text fontSize="lg" fontWeight="semibold" color="orange.fg">
                                {existingClass.pending_instructors}
                              </Text>
                              <Text fontSize="sm" color="fg.muted">
                                pending
                              </Text>
                            </HStack>
                          )}
                        </VStack>
                      </VStack>

                      {/* TAs/Graders */}
                      {(existingClass.grader_count > 0 || existingClass.pending_graders > 0) && (
                        <VStack align="center" gap={2} p={4} bg="teal.bg" rounded="md">
                          <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                            Graders/TAs
                          </Text>
                          <VStack gap={1}>
                            {existingClass.grader_count > 0 && (
                              <HStack gap={2}>
                                <Text fontSize="2xl" fontWeight="bold" color="teal.fg">
                                  {existingClass.grader_count}
                                </Text>
                                <Text fontSize="sm" color="fg.muted">
                                  enrolled
                                </Text>
                              </HStack>
                            )}
                            {existingClass.pending_graders > 0 && (
                              <HStack gap={2}>
                                <Text fontSize="lg" fontWeight="semibold" color="orange.fg">
                                  {existingClass.pending_graders}
                                </Text>
                                <Text fontSize="sm" color="fg.muted">
                                  pending
                                </Text>
                              </HStack>
                            )}
                          </VStack>
                        </VStack>
                      )}
                    </Grid>
                  </Box>
                </VStack>
              </Card.Body>
            </Card.Root>
          )}

          {/* Enhanced Enrollment Summary */}
          <Card.Root>
            <Card.Header>
              <Card.Title>Enrollment Status</Card.Title>
              <Text color="fg.muted">Comparison between SIS enrollment and current Pawtograder state</Text>
            </Card.Header>
            <Card.Body>
              <VStack gap={6}>
                {/* Instructors */}
                <Box w="full">
                  <HStack gap={3} mb={3}>
                    <GraduationCap size={20} />
                    <Text fontWeight="semibold" fontSize="lg">
                      Instructors
                    </Text>
                  </HStack>
                  <Grid templateColumns="repeat(4, 1fr)" gap={4}>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                        {importData.enrollmentStatus.instructors.inSIS}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In SIS
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="green.fg">
                        {importData.enrollmentStatus.instructors.inPawtograder}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In Pawtograder
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="orange.fg">
                        {importData.enrollmentStatus.instructors.pendingInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        Pending Invites
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="purple.fg">
                        {importData.enrollmentStatus.instructors.newInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        New Invites
                      </Text>
                    </VStack>
                  </Grid>
                </Box>

                {/* Graders/TAs */}
                <Box w="full">
                  <HStack gap={3} mb={3}>
                    <Users size={20} />
                    <Text fontWeight="semibold" fontSize="lg">
                      Graders/TAs
                    </Text>
                  </HStack>
                  <Grid templateColumns="repeat(4, 1fr)" gap={4}>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                        {importData.enrollmentStatus.graders.inSIS}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In SIS
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="green.fg">
                        {importData.enrollmentStatus.graders.inPawtograder}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In Pawtograder
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="orange.fg">
                        {importData.enrollmentStatus.graders.pendingInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        Pending Invites
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="purple.fg">
                        {importData.enrollmentStatus.graders.newInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        New Invites
                      </Text>
                    </VStack>
                  </Grid>
                </Box>

                {/* Students */}
                <Box w="full">
                  <HStack gap={3} mb={3}>
                    <BookOpen size={20} />
                    <Text fontWeight="semibold" fontSize="lg">
                      Students
                    </Text>
                  </HStack>
                  <Grid templateColumns="repeat(4, 1fr)" gap={4}>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                        {importData.enrollmentStatus.students.inSIS}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In SIS
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="green.fg">
                        {importData.enrollmentStatus.students.inPawtograder}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        In Pawtograder
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="orange.fg">
                        {importData.enrollmentStatus.students.pendingInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        Pending Invites
                      </Text>
                    </VStack>
                    <VStack gap={1}>
                      <Text fontSize="2xl" fontWeight="bold" color="purple.fg">
                        {importData.enrollmentStatus.students.newInvitations}
                      </Text>
                      <Text fontSize="xs" color="fg.muted" textAlign="center">
                        New Invites
                      </Text>
                    </VStack>
                  </Grid>
                </Box>
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Sections Selection */}
          <Card.Root>
            <Card.Header>
              <Flex justify="space-between" align="center">
                <VStack align="start" gap={1}>
                  <Card.Title>Course Sections</Card.Title>
                  <Text color="fg.muted">Select sections to import</Text>
                </VStack>
                <VStack gap={2}>
                  <Button variant="outline" size="sm" onClick={toggleAllSections}>
                    {selectedSections.size === importData.sections.length ? "Deselect All" : "Select All"}
                  </Button>
                  <Text fontSize="sm" color="fg.muted">
                    {selectedSections.size} of {importData.sections.length} selected
                  </Text>
                </VStack>
              </Flex>
            </Card.Header>
            <Card.Body>
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>
                      <VStack align="center" gap={2}>
                        <Text fontSize="sm" fontWeight="medium">
                          Select
                        </Text>
                        <Checkbox.Root
                          checked={
                            selectedSections.size === importData.sections.length && importData.sections.length > 0
                          }
                          onCheckedChange={toggleAllSections}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                        </Checkbox.Root>
                      </VStack>
                    </Table.ColumnHeader>
                    <Table.ColumnHeader>CRN</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>Type</Table.ColumnHeader>
                    <Table.ColumnHeader>Section</Table.ColumnHeader>
                    <Table.ColumnHeader>Instructors</Table.ColumnHeader>
                    <Table.ColumnHeader>Meeting Info</Table.ColumnHeader>
                    <Table.ColumnHeader>Location</Table.ColumnHeader>
                    <Table.ColumnHeader>Enrollments</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {importData.sections.map((section) => {
                    const sectionStatus = getSectionStatus(section.crn);
                    return (
                      <Table.Row
                        key={section.crn}
                        _hover={{ bg: "bg.muted" }}
                        cursor="pointer"
                        onClick={() => toggleSection(section.crn)}
                      >
                        <Table.Cell>
                          <Checkbox.Root
                            checked={selectedSections.has(section.crn)}
                            onCheckedChange={() => toggleSection(section.crn)}
                            onClick={(e) => e.stopPropagation()} // Prevent double-toggle when clicking checkbox directly
                          >
                            <Checkbox.HiddenInput />
                            <Checkbox.Control />
                          </Checkbox.Root>
                        </Table.Cell>
                        <Table.Cell>
                          <Text fontFamily="mono" fontWeight="medium">
                            {section.crn}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <VStack align="start" gap={1}>
                            <Badge colorPalette={sectionStatus.color} size="sm">
                              {sectionStatus.badge}
                            </Badge>
                            {sectionStatus.memberCount !== null && (
                              <Text fontSize="xs" color="fg.muted">
                                {sectionStatus.memberCount} current members
                              </Text>
                            )}
                          </VStack>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge colorPalette={section.sectionType === "class" ? "blue" : "green"}>
                            {section.sectionType === "class" ? "Class" : "Lab"}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <Text fontWeight="medium">{section.sectionName}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <VStack align="start" gap={1}>
                            {section.instructors.map((instructor, idx) => (
                              <Text key={idx} fontSize="sm" fontWeight="medium">
                                {formatInstructorName(instructor.name)}
                              </Text>
                            ))}
                            {section.instructors.length === 0 && (
                              <Text fontSize="sm" color="fg.muted">
                                No instructors
                              </Text>
                            )}
                          </VStack>
                        </Table.Cell>
                        <Table.Cell>
                          <Text fontSize="sm">{section.meetingInfo}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text fontSize="sm">{section.location}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <HStack gap={2}>
                            {section.instructors.length > 0 && (
                              <Badge size="sm" colorPalette="blue">
                                {section.instructors.length} instructor{section.instructors.length !== 1 ? "s" : ""}
                              </Badge>
                            )}
                            {section.tas.length > 0 && (
                              <Badge size="sm" colorPalette="green">
                                {section.tas.length} TA{section.tas.length !== 1 ? "s" : ""}
                              </Badge>
                            )}
                            <Badge size="sm" colorPalette="purple">
                              {section.students.length} student{section.students.length !== 1 ? "s" : ""}
                            </Badge>
                          </HStack>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </Card.Body>
          </Card.Root>

          {/* Create Class Action */}
          <Card.Root>
            <Card.Header>
              <Card.Title>
                {selectedExistingClassId
                  ? "Sync to Existing Class & Send Invitations"
                  : "Create Class & Send Invitations"}
              </Card.Title>
              <HStack gap={2}>
                <AlertCircle size={16} />
                <Text color="orange.fg" fontSize="sm">
                  {selectedExistingClassId
                    ? "This will sync sections to the existing class and send invitations to new users"
                    : "This will create the class and send invitations to all users in selected sections"}
                </Text>
              </HStack>
            </Card.Header>
            <Card.Body>
              <VStack gap={4}>
                {(() => {
                  const analysis = getCreationAnalysis();
                  if (!analysis) return null;

                  return (
                    <Box w="full" p={4} bg="bg.muted" rounded="md">
                      <Text fontWeight="semibold" mb={3}>
                        Import Summary:
                      </Text>
                      <VStack align="start" gap={2}>
                        {/* Class Status */}
                        <HStack gap={2}>
                          <Text fontSize="sm">•</Text>
                          {selectedExistingClassId ? (
                            <Text fontSize="sm">
                              <Text as="span" color="orange.fg" fontWeight="medium">
                                Sync to existing class:
                              </Text>{" "}
                              {importData?.courseInfo.course}
                            </Text>
                          ) : (
                            <Text fontSize="sm">
                              <Text as="span" color="green.fg" fontWeight="medium">
                                Create new class:
                              </Text>{" "}
                              {importData?.courseInfo.course}
                            </Text>
                          )}
                        </HStack>

                        {/* Class Sections */}
                        <HStack gap={2}>
                          <Text fontSize="sm">•</Text>
                          <Text fontSize="sm">
                            Class sections: {analysis.classSections.total} total
                            {analysis.classSections.existing > 0 && (
                              <Text as="span" color="orange.fg">
                                {" "}
                                ({analysis.classSections.existing} existing, {analysis.classSections.new} new)
                              </Text>
                            )}
                            {analysis.classSections.existing === 0 && analysis.classSections.new > 0 && (
                              <Text as="span" color="green.fg">
                                {" "}
                                (all new)
                              </Text>
                            )}
                          </Text>
                        </HStack>

                        {/* Lab Sections */}
                        {analysis.labSections.total > 0 && (
                          <HStack gap={2}>
                            <Text fontSize="sm">•</Text>
                            <Text fontSize="sm">
                              Lab sections: {analysis.labSections.total} total
                              {analysis.labSections.existing > 0 && (
                                <Text as="span" color="orange.fg">
                                  {" "}
                                  ({analysis.labSections.existing} existing, {analysis.labSections.new} new)
                                </Text>
                              )}
                              {analysis.labSections.existing === 0 && analysis.labSections.new > 0 && (
                                <Text as="span" color="green.fg">
                                  {" "}
                                  (all new)
                                </Text>
                              )}
                            </Text>
                          </HStack>
                        )}

                        {/* Users/Invitations */}
                        <HStack gap={2}>
                          <Text fontSize="sm">•</Text>
                          <Text fontSize="sm">
                            Users: ~{analysis.users.total} total
                            {analysis.users.existing > 0 && (
                              <Text as="span" color="orange.fg">
                                {" "}
                                ({analysis.users.existing} enrolled, ~{analysis.users.newInvitations} new invitations)
                              </Text>
                            )}
                            {analysis.users.existing === 0 && (
                              <Text as="span" color="green.fg">
                                {" "}
                                (~{analysis.users.newInvitations} new invitations)
                              </Text>
                            )}
                          </Text>
                        </HStack>

                        {/* Additional Context */}
                        {analysis.classExists && (
                          <HStack gap={2} mt={2} p={2} bg="orange.subtle" rounded="sm">
                            <AlertCircle size={14} />
                            <Text fontSize="xs" color="orange.fg">
                              Syncing to existing class will update sections and send invitations to new users only
                            </Text>
                          </HStack>
                        )}
                      </VStack>
                    </Box>
                  );
                })()}

                {/* Invitation Processing Progress */}
                {invitationProgress && (
                  <Box w="full" p={4} bg="blue.subtle" rounded="md" border="1px" borderColor="blue.border">
                    <VStack gap={3}>
                      <HStack justify="space-between" w="full">
                        <Text fontSize="sm" fontWeight="semibold" color="blue.fg">
                          Processing Invitations
                        </Text>
                        <Text fontSize="sm" color="blue.fg">
                          Batch {invitationProgress.currentBatch} of {invitationProgress.totalBatches}
                        </Text>
                      </HStack>

                      <Box w="full">
                        <Box w="full" h="6px" bg="blue.muted" rounded="md" overflow="hidden" position="relative">
                          <Box
                            h="full"
                            bg="blue.solid"
                            rounded="md"
                            transition="width 0.3s ease"
                            style={{
                              width: `${Math.round((invitationProgress.current / invitationProgress.total) * 100)}%`
                            }}
                          />
                        </Box>
                        <HStack justify="space-between" mt={1}>
                          <Text fontSize="xs" color="blue.fg">
                            {invitationProgress.current} of {invitationProgress.total} invitations processed
                          </Text>
                          <Text fontSize="xs" color="blue.fg">
                            {Math.round((invitationProgress.current / invitationProgress.total) * 100)}%
                          </Text>
                        </HStack>
                      </Box>

                      <Text fontSize="xs" color="blue.fg" textAlign="center">
                        Please wait while invitations are processed in batches of 50...
                      </Text>
                    </VStack>
                  </Box>
                )}

                <Button
                  onClick={handleCreateClass}
                  loading={isCreating}
                  disabled={selectedSections.size === 0 || !!invitationProgress}
                  size="lg"
                  colorScheme="blue"
                >
                  {isCreating
                    ? selectedExistingClassId
                      ? "Syncing..."
                      : "Creating..."
                    : selectedExistingClassId
                      ? "Sync to Existing Class & Send Invitations"
                      : "Create Class & Send Invitations"}
                </Button>
              </VStack>
            </Card.Body>
          </Card.Root>
        </>
      )}

      {/* Import Summary */}
      {importSummary && (
        <Card.Root>
          <Card.Header>
            <Card.Title>Import Summary</Card.Title>
            <Text color="fg.muted">Results from the class creation and invitation process</Text>
          </Card.Header>
          <Card.Body>
            <VStack gap={4}>
              <Grid templateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap={4}>
                <VStack
                  align="center"
                  gap={2}
                  p={4}
                  bg={importSummary.classCreated ? "green.bg" : "red.bg"}
                  rounded="md"
                >
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Class Status
                  </Text>
                  <Text fontSize="2xl" fontWeight="bold" color={importSummary.classCreated ? "green.fg" : "red.fg"}>
                    {importSummary.classCreated ? "✓ Created" : "✗ Failed"}
                  </Text>
                  {importSummary.classId && (
                    <Text fontSize="xs" color="fg.muted">
                      Class ID: {importSummary.classId}
                    </Text>
                  )}
                </VStack>

                <VStack align="center" gap={2} p={4} bg="blue.bg" rounded="md">
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Sections Created
                  </Text>
                  <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                    {importSummary.sectionsCreated}
                  </Text>
                </VStack>

                <VStack align="center" gap={2} p={4} bg="purple.bg" rounded="md">
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Invitations Sent
                  </Text>
                  <Text fontSize="2xl" fontWeight="bold" color="purple.fg">
                    {importSummary.invitationsSent}
                  </Text>
                </VStack>

                <VStack
                  align="center"
                  gap={2}
                  p={4}
                  bg={importSummary.errors.length > 0 ? "orange.bg" : "gray.bg"}
                  rounded="md"
                >
                  <Text fontSize="sm" fontWeight="semibold" color="fg.muted">
                    Errors
                  </Text>
                  <Text
                    fontSize="2xl"
                    fontWeight="bold"
                    color={importSummary.errors.length > 0 ? "orange.fg" : "gray.fg"}
                  >
                    {importSummary.errors.length}
                  </Text>
                </VStack>
              </Grid>

              {importSummary.errors.length > 0 && (
                <Box w="full">
                  <Text fontWeight="semibold" mb={2} color="orange.fg">
                    Errors encountered:
                  </Text>
                  <VStack align="start" gap={1}>
                    {importSummary.errors.map((error, idx) => (
                      <Text key={idx} fontSize="sm" color="red.fg" p={2} bg="red.bg" rounded="md" w="full">
                        {error}
                      </Text>
                    ))}
                  </VStack>
                </Box>
              )}

              <Button
                onClick={() => {
                  setImportSummary(null);
                  setInvitationProgress(null);
                  window.location.reload();
                }}
                variant="outline"
                size="sm"
              >
                Start New Import
              </Button>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
