import { addDays, subDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createDueDateException,
  createRegradeRequest,
  createUserInClass,
  gradeSubmission,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "../tests/e2e/TestingUtils";

dotenv.config({ path: ".env.local" });

// Rubric part templates for generating diverse rubrics
const RUBRIC_PART_TEMPLATES = [
  {
    name: "Code Quality",
    description: "Assessment of code structure, style, and best practices",
    criteria: [
      {
        name: "Code Style & Formatting",
        description: "Proper indentation, naming conventions, and formatting",
        points: [3, 5, 8],
        checks: [
          { name: "Consistent Indentation", points: [1, 2], isAnnotation: true },
          { name: "Meaningful Variable Names", points: [2, 3], isAnnotation: true },
          { name: "Proper Code Comments", points: [1, 2, 3], isAnnotation: false }
        ]
      },
      {
        name: "Code Organization",
        description: "Logical structure and separation of concerns",
        points: [5, 8, 10],
        checks: [
          { name: "Function Decomposition", points: [2, 3, 4], isAnnotation: true },
          { name: "Class Structure", points: [2, 3], isAnnotation: true },
          { name: "Code Modularity", points: [1, 2, 3], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Algorithm Implementation",
    description: "Correctness and efficiency of algorithmic solutions",
    criteria: [
      {
        name: "Correctness",
        description: "Implementation correctly solves the problem",
        points: [15, 20, 25],
        checks: [
          { name: "Handles Base Cases", points: [3, 5], isAnnotation: true },
          { name: "Correct Logic Flow", points: [5, 8, 10], isAnnotation: true },
          { name: "Edge Case Handling", points: [2, 4, 5], isAnnotation: false }
        ]
      },
      {
        name: "Efficiency",
        description: "Time and space complexity considerations",
        points: [8, 12, 15],
        checks: [
          { name: "Optimal Time Complexity", points: [3, 5, 7], isAnnotation: false },
          { name: "Memory Usage", points: [2, 3, 4], isAnnotation: true },
          { name: "Algorithm Choice", points: [2, 3, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Testing & Documentation",
    description: "Quality of tests and documentation provided",
    criteria: [
      {
        name: "Test Coverage",
        description: "Comprehensive testing of functionality",
        points: [10, 15],
        checks: [
          { name: "Unit Tests Present", points: [3, 5], isAnnotation: false },
          { name: "Test Edge Cases", points: [2, 4], isAnnotation: true },
          { name: "Test Documentation", points: [2, 3], isAnnotation: false }
        ]
      },
      {
        name: "Documentation Quality",
        description: "Clear and comprehensive documentation",
        points: [8, 12],
        checks: [
          { name: "README Completeness", points: [2, 4], isAnnotation: false },
          { name: "API Documentation", points: [2, 3, 4], isAnnotation: true },
          { name: "Usage Examples", points: [1, 2, 3], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Problem Solving",
    description: "Approach to understanding and solving the problem",
    criteria: [
      {
        name: "Problem Analysis",
        description: "Understanding and breakdown of the problem",
        points: [8, 12],
        checks: [
          { name: "Requirements Understanding", points: [2, 4], isAnnotation: false },
          { name: "Problem Decomposition", points: [3, 4], isAnnotation: true },
          { name: "Solution Planning", points: [2, 3, 4], isAnnotation: false }
        ]
      },
      {
        name: "Implementation Strategy",
        description: "Approach to implementing the solution",
        points: [10, 15],
        checks: [
          { name: "Design Patterns Usage", points: [3, 5], isAnnotation: true },
          { name: "Error Handling", points: [2, 4], isAnnotation: true },
          { name: "Code Reusability", points: [2, 3, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "User Experience",
    description: "Quality of user interface and interaction design",
    criteria: [
      {
        name: "Interface Design",
        description: "Visual design and layout quality",
        points: [8, 12, 15],
        checks: [
          { name: "Visual Hierarchy", points: [2, 3, 4], isAnnotation: true },
          { name: "Color Scheme", points: [1, 2, 3], isAnnotation: true },
          { name: "Layout Consistency", points: [2, 4], isAnnotation: false }
        ]
      },
      {
        name: "Usability",
        description: "Ease of use and user interaction quality",
        points: [10, 15],
        checks: [
          { name: "Navigation Clarity", points: [3, 5], isAnnotation: false },
          { name: "User Feedback", points: [2, 3, 4], isAnnotation: true },
          { name: "Accessibility Features", points: [2, 4], isAnnotation: false }
        ]
      }
    ]
  },
  {
    name: "Security & Performance",
    description: "Security considerations and performance optimization",
    criteria: [
      {
        name: "Security Practices",
        description: "Implementation of security best practices",
        points: [12, 18],
        checks: [
          { name: "Input Validation", points: [3, 5], isAnnotation: true },
          { name: "Authentication Handling", points: [4, 6], isAnnotation: true },
          { name: "Data Protection", points: [2, 4], isAnnotation: false }
        ]
      },
      {
        name: "Performance Optimization",
        description: "Code efficiency and optimization techniques",
        points: [8, 12],
        checks: [
          { name: "Resource Management", points: [2, 4], isAnnotation: true },
          { name: "Caching Strategy", points: [2, 3, 4], isAnnotation: false },
          { name: "Load Time Optimization", points: [2, 3], isAnnotation: false }
        ]
      }
    ]
  }
];

// Helper function to generate random rubric structure
function generateRubricStructure(config: NonNullable<SeedingOptions["rubricConfig"]>) {
  const numParts =
    Math.floor(Math.random() * (config.maxPartsPerAssignment - config.minPartsPerAssignment + 1)) +
    config.minPartsPerAssignment;

  // Shuffle and select random rubric parts
  const shuffledTemplates = [...RUBRIC_PART_TEMPLATES].sort(() => Math.random() - 0.5);
  const selectedParts = shuffledTemplates.slice(0, Math.min(numParts, RUBRIC_PART_TEMPLATES.length));

  return selectedParts.map((partTemplate, partIndex) => {
    const numCriteria =
      Math.floor(Math.random() * (config.maxCriteriaPerPart - config.minCriteriaPerPart + 1)) +
      config.minCriteriaPerPart;
    const selectedCriteria = partTemplate.criteria.slice(0, Math.min(numCriteria, partTemplate.criteria.length));

    return {
      ...partTemplate,
      ordinal: partIndex,
      criteria: selectedCriteria.map((criteriaTemplate, criteriaIndex) => {
        const numChecks =
          Math.floor(Math.random() * (config.maxChecksPerCriteria - config.minChecksPerCriteria + 1)) +
          config.minChecksPerCriteria;
        const selectedChecks = criteriaTemplate.checks.slice(0, Math.min(numChecks, criteriaTemplate.checks.length));

        // Randomly select points from the available options
        const criteriaPoints = criteriaTemplate.points[Math.floor(Math.random() * criteriaTemplate.points.length)];

        return {
          ...criteriaTemplate,
          ordinal: criteriaIndex,
          total_points: criteriaPoints,
          checks: selectedChecks.map((checkTemplate, checkIndex) => {
            const checkPoints = checkTemplate.points[Math.floor(Math.random() * checkTemplate.points.length)];
            return {
              ...checkTemplate,
              ordinal: checkIndex,
              points: checkPoints,
              is_annotation: checkTemplate.isAnnotation,
              is_comment_required: Math.random() < 0.3, // 30% chance of requiring comments
              is_required: Math.random() < 0.7 // 70% chance of being required
            };
          })
        };
      })
    };
  });
}

// Enhanced assignment creation function that generates diverse rubrics
async function insertEnhancedAssignment({
  due_date,
  lab_due_date_offset,
  allow_not_graded_submissions,
  class_id,
  rubricConfig
}: {
  due_date: string;
  lab_due_date_offset?: number;
  allow_not_graded_submissions?: boolean;
  class_id: number;
  rubricConfig: NonNullable<SeedingOptions["rubricConfig"]>;
}): Promise<{
  id: number;
  title: string;
  rubricChecks: Array<{
    id: number;
    name: string;
    points: number;
    [key: string]: unknown;
  }>;
  rubricParts: Array<{
    id: number;
    name: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}> {
  const assignmentIdx = Math.floor(Math.random() * 1000) + 1;
  const title = `Enhanced Assignment ${assignmentIdx}`;

  // Create self review setting
  const { data: selfReviewSettingData, error: selfReviewSettingError } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: class_id,
      enabled: true,
      deadline_offset: 2,
      allow_early: true
    })
    .select("id")
    .single();

  if (selfReviewSettingError) {
    throw new Error(`Failed to create self review setting: ${selfReviewSettingError.message}`);
  }

  const self_review_setting_id = selfReviewSettingData.id;

  // Create assignment
  const { data: insertedAssignmentData, error: assignmentError } = await supabase
    .from("assignments")
    .insert({
      title: title,
      description: "This is an enhanced test assignment with diverse rubric structure",
      due_date: due_date,
      minutes_due_after_lab: lab_due_date_offset,
      template_repo: "pawtograder-playground/test-e2e-handout-repo-java",
      autograder_points: 100,
      total_points: 100,
      max_late_tokens: 10,
      release_date: addDays(new Date(), -1).toUTCString(),
      class_id: class_id,
      slug: `enhanced-assignment-${assignmentIdx}`,
      group_config: "individual",
      allow_not_graded_submissions: allow_not_graded_submissions || false,
      self_review_setting_id: self_review_setting_id
    })
    .select("id")
    .single();

  if (assignmentError) {
    throw new Error(`Failed to create assignment: ${assignmentError.message}`);
  }

  // Get assignment data
  const { data: assignmentData } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", insertedAssignmentData.id)
    .single();

  if (!assignmentData) {
    throw new Error("Failed to get assignment");
  }

  // Update autograder config
  await supabase
    .from("autograder")
    .update({
      config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
    })
    .eq("id", assignmentData.id);

  // Generate diverse rubric structure
  const rubricStructure = generateRubricStructure(rubricConfig);

  // Create self-review rubric parts (always include basic self-review)
  const selfReviewPart = {
    name: "Self Review",
    description: "Student self-assessment of their work",
    ordinal: 0,
    criteria: [
      {
        name: "Self Reflection",
        description: "Quality of self-assessment and reflection",
        ordinal: 0,
        total_points: 10,
        checks: [
          {
            name: "Completeness of Self Review",
            ordinal: 0,
            points: 5,
            is_annotation: false,
            is_comment_required: false,
            is_required: true
          },
          {
            name: "Depth of Reflection",
            ordinal: 1,
            points: 5,
            is_annotation: false,
            is_comment_required: true,
            is_required: true
          }
        ]
      }
    ]
  };

  // Combine self-review with generated structure for grading rubric
  const allParts = [selfReviewPart, ...rubricStructure.map((part) => ({ ...part, ordinal: part.ordinal + 1 }))];

  // Create rubric parts
  const createdParts = [];
  const allRubricChecks = [];

  for (const partTemplate of allParts) {
    const isGradingPart = partTemplate.name !== "Self Review";
    const rubricId = isGradingPart ? assignmentData.grading_rubric_id : assignmentData.self_review_rubric_id;

    const { data: partData, error: partError } = await supabase
      .from("rubric_parts")
      .insert({
        class_id: class_id,
        name: partTemplate.name,
        description: partTemplate.description,
        ordinal: partTemplate.ordinal,
        rubric_id: rubricId || 0
      })
      .select("id")
      .single();

    if (partError) {
      throw new Error(`Failed to create rubric part: ${partError.message}`);
    }

    createdParts.push({ ...partTemplate, id: partData.id, rubric_id: rubricId });

    // Create criteria for this part
    for (const criteriaTemplate of partTemplate.criteria) {
      const { data: criteriaData, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          class_id: class_id,
          name: criteriaTemplate.name,
          description: criteriaTemplate.description,
          ordinal: criteriaTemplate.ordinal,
          total_points: criteriaTemplate.total_points,
          is_additive: true,
          rubric_part_id: partData.id,
          rubric_id: rubricId || 0
        })
        .select("id")
        .single();

      if (criteriaError) {
        throw new Error(`Failed to create rubric criteria: ${criteriaError.message}`);
      }

      // Create checks for this criteria
      for (const checkTemplate of criteriaTemplate.checks) {
        const { data: checkData, error: checkError } = await supabase
          .from("rubric_checks")
          .insert({
            rubric_criteria_id: criteriaData.id,
            name: checkTemplate.name,
            description: `${checkTemplate.name} evaluation`,
            ordinal: checkTemplate.ordinal,
            points: checkTemplate.points,
            is_annotation: checkTemplate.is_annotation,
            is_comment_required: checkTemplate.is_comment_required,
            class_id: class_id,
            is_required: checkTemplate.is_required
          })
          .select("*")
          .single();

        if (checkError) {
          throw new Error(`Failed to create rubric check: ${checkError.message}`);
        }

        allRubricChecks.push(checkData);
      }
    }
  }

  return {
    ...assignmentData,
    rubricChecks: allRubricChecks,
    rubricParts: createdParts,
    due_date: assignmentData.due_date
  };
}

// Helper function to create class sections
async function createClassSections(class_id: number, numSections: number) {
  const sections = [];

  for (let i = 1; i <= numSections; i++) {
    const { data: sectionData, error: sectionError } = await supabase
      .from("class_sections")
      .insert({
        class_id: class_id,
        name: `Section ${String(i).padStart(2, "0")}`
      })
      .select("id, name")
      .single();

    if (sectionError) {
      throw new Error(`Failed to create class section: ${sectionError.message}`);
    }

    sections.push(sectionData);
  }

  return sections;
}

// Helper function to create lab sections
async function createLabSections(class_id: number, numSections: number, instructorId: string) {
  const sections = [];
  const daysOfWeek = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
  const times = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];

  for (let i = 1; i <= numSections; i++) {
    const dayIndex = (i - 1) % daysOfWeek.length;
    const timeIndex = Math.floor((i - 1) / daysOfWeek.length) % times.length;
    const startTime = times[timeIndex];
    const endTime = `${String(parseInt(startTime.split(":")[0]) + 1).padStart(2, "0")}:${startTime.split(":")[1]}`;

    const { data: sectionData, error: sectionError } = await supabase
      .from("lab_sections")
      .insert({
        class_id: class_id,
        name: `Lab ${String.fromCharCode(64 + i)}`, // Lab A, Lab B, etc.
        day_of_week: daysOfWeek[dayIndex],
        start_time: startTime,
        end_time: endTime,
        lab_leader_id: instructorId,
        description: `Lab section ${String.fromCharCode(64 + i)} - ${daysOfWeek[dayIndex]} ${startTime}-${endTime}`
      })
      .select("id, name")
      .single();

    if (sectionError) {
      throw new Error(`Failed to create lab section: ${sectionError.message}`);
    }

    sections.push(sectionData);
  }

  return sections;
}

// Helper function to define tag types (name/color combinations)
function defineTagTypes(prefix: string, numTagTypes: number) {
  const tagTypes = [];
  const colors = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#06b6d4",
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#6b7280",
    "#f59e0b"
  ];

  for (let i = 1; i <= numTagTypes; i++) {
    const colorIndex = (i - 1) % colors.length;
    tagTypes.push({
      name: `${prefix} ${String(i).padStart(2, "0")}`,
      color: colors[colorIndex]
    });
  }

  return tagTypes;
}

// Helper function to randomly assign users to sections and tags
async function assignUsersToSectionsAndTags(
  users: TestingUser[],
  classSections: Array<{ id: number; name: string }>,
  labSections: Array<{ id: number; name: string }>,
  tagTypes: Array<{ name: string; color: string }>,
  class_id: number,
  userType: "student" | "grader",
  creatorId: string
) {
  const assignments = [];

  for (const user of users) {
    // Randomly assign to class section (all users get one)
    const classSection = classSections[Math.floor(Math.random() * classSections.length)];

    // Randomly assign to lab section (students only, ~80% chance)
    let labSection = null;
    if (userType === "student" && Math.random() < 0.8) {
      labSection = labSections[Math.floor(Math.random() * labSections.length)];
    }

    // Update user role with section assignments
    const { error: updateError } = await supabase
      .from("user_roles")
      .update({
        class_section_id: classSection.id,
        lab_section_id: labSection?.id || null
      })
      .eq("class_id", class_id)
      .eq("private_profile_id", user.private_profile_id);

    if (updateError) {
      throw new Error(`Failed to assign sections to user: ${updateError.message}`);
    }

    // Randomly assign tags (30-60% chance per tag type)
    const userTags = [];
    for (const tagType of tagTypes) {
      if (Math.random() < 0.3 + Math.random() * 0.3) {
        // 30-60% chance
        // Create a tag record for this user
        const { data: tagData, error: tagError } = await supabase
          .from("tags")
          .insert({
            class_id: class_id,
            name: tagType.name,
            color: tagType.color,
            visible: true,
            profile_id: user.private_profile_id,
            creator_id: creatorId
          })
          .select("id, name, color")
          .single();

        if (tagError) {
          console.warn(`Failed to create tag ${tagType.name} for user: ${tagError.message}`);
        } else {
          userTags.push(tagData);
        }
      }
    }

    assignments.push({
      user: user.email,
      classSection: classSection.name,
      labSection: labSection?.name || null,
      tags: userTags.map((t) => t.name)
    });
  }

  return assignments;
}

interface SeedingOptions {
  numStudents: number;
  numGraders: number;
  numAssignments: number;
  firstAssignmentDate: Date;
  lastAssignmentDate: Date;
  rubricConfig?: {
    minPartsPerAssignment: number;
    maxPartsPerAssignment: number;
    minCriteriaPerPart: number;
    maxCriteriaPerPart: number;
    minChecksPerCriteria: number;
    maxChecksPerCriteria: number;
  };
  sectionsAndTagsConfig?: {
    numClassSections: number;
    numLabSections: number;
    numStudentTags: number;
    numGraderTags: number;
  };
}

async function seedInstructorDashboardData(options: SeedingOptions) {
  const {
    numStudents,
    numGraders,
    numAssignments,
    firstAssignmentDate,
    lastAssignmentDate,
    rubricConfig,
    sectionsAndTagsConfig
  } = options;

  // Default rubric configuration if not provided
  const defaultRubricConfig = {
    minPartsPerAssignment: 2,
    maxPartsPerAssignment: 4,
    minCriteriaPerPart: 1,
    maxCriteriaPerPart: 2,
    minChecksPerCriteria: 2,
    maxChecksPerCriteria: 3
  };

  const effectiveRubricConfig = rubricConfig || defaultRubricConfig;

  // Default sections and tags configuration if not provided
  const defaultSectionsAndTagsConfig = {
    numClassSections: 2,
    numLabSections: 2,
    numStudentTags: 2,
    numGraderTags: 4
  };

  const effectiveSectionsAndTagsConfig = sectionsAndTagsConfig || defaultSectionsAndTagsConfig;

  console.log("🌱 Starting instructor dashboard data seeding...\n");
  console.log(`📊 Configuration:`);
  console.log(`   Students: ${numStudents}`);
  console.log(`   Graders: ${numGraders}`);
  console.log(`   Assignments: ${numAssignments}`);
  console.log(`   First Assignment: ${firstAssignmentDate.toISOString().split("T")[0]}`);
  console.log(`   Last Assignment: ${lastAssignmentDate.toISOString().split("T")[0]}`);
  console.log(
    `   Rubric Parts Range: ${effectiveRubricConfig.minPartsPerAssignment}-${effectiveRubricConfig.maxPartsPerAssignment}`
  );
  console.log(
    `   Criteria per Part: ${effectiveRubricConfig.minCriteriaPerPart}-${effectiveRubricConfig.maxCriteriaPerPart}`
  );
  console.log(
    `   Checks per Criteria: ${effectiveRubricConfig.minChecksPerCriteria}-${effectiveRubricConfig.maxChecksPerCriteria}`
  );
  console.log(`   Class Sections: ${effectiveSectionsAndTagsConfig.numClassSections}`);
  console.log(`   Lab Sections: ${effectiveSectionsAndTagsConfig.numLabSections}`);
  console.log(`   Student Tags: ${effectiveSectionsAndTagsConfig.numStudentTags}`);
  console.log(`   Grader Tags: ${effectiveSectionsAndTagsConfig.numGraderTags}\n`);

  try {
    // Create test class using TestingUtils
    const testClass = await createClass();
    const class_id = testClass.id;
    console.log(`✓ Created test class: ${testClass.name} (ID: ${class_id})`);

    // Create users using TestingUtils
    console.log("\n👥 Creating test users...");
    const instructor = await createUserInClass({ role: "instructor", class_id });

    const graders: TestingUser[] = [];
    for (let i = 1; i <= numGraders; i++) {
      graders.push(await createUserInClass({ role: "grader", class_id }));
      if (i % 10 === 0) {
        console.log(`  ✓ Created ${i} graders...`);
      }
    }

    const students: TestingUser[] = [];
    for (let i = 1; i <= numStudents; i++) {
      students.push(await createUserInClass({ role: "student", class_id }));
      if (i % 100 === 0) {
        console.log(`  ✓ Created ${i} students...`);
      }
    }
    console.log(`✓ Created ${students.length} students, 1 instructor, ${graders.length} graders`);

    // Create sections and tags
    console.log("\n🏫 Creating class and lab sections...");
    const classSections = await createClassSections(class_id, effectiveSectionsAndTagsConfig.numClassSections);
    console.log(`✓ Created ${classSections.length} class sections`);

    const labSections = await createLabSections(
      class_id,
      effectiveSectionsAndTagsConfig.numLabSections,
      instructor.private_profile_id
    );
    console.log(`✓ Created ${labSections.length} lab sections`);

    console.log("\n🏷️ Defining tag types...");
    const studentTagTypes = defineTagTypes("Student", effectiveSectionsAndTagsConfig.numStudentTags);
    console.log(`✓ Defined ${studentTagTypes.length} student tag types`);

    const graderTagTypes = defineTagTypes("Grader", effectiveSectionsAndTagsConfig.numGraderTags);
    console.log(`✓ Defined ${graderTagTypes.length} grader tag types`);

    // Assign users to sections and tags
    console.log("\n🎯 Assigning students to sections and tags...");
    await assignUsersToSectionsAndTags(
      students,
      classSections,
      labSections,
      studentTagTypes,
      class_id,
      "student",
      instructor.private_profile_id
    );
    console.log(`✓ Assigned ${students.length} students to sections and tags`);

    console.log("\n🎯 Assigning graders to sections and tags...");
    await assignUsersToSectionsAndTags(
      graders,
      classSections,
      labSections,
      graderTagTypes,
      class_id,
      "grader",
      instructor.private_profile_id
    );
    console.log(`✓ Assigned ${graders.length} graders to sections and tags`);

    // Create assignments with enhanced rubric generation
    console.log("\n📚 Creating test assignments with diverse rubrics...");
    const now = new Date();

    // Calculate evenly spaced dates between first and last assignment
    const timeDiff = lastAssignmentDate.getTime() - firstAssignmentDate.getTime();
    const timeStep = timeDiff / (numAssignments - 1);

    const assignments = [];
    const assignmentRubricSummaries = [];

    for (let i = 0; i < numAssignments; i++) {
      const assignmentDate = new Date(firstAssignmentDate.getTime() + timeStep * i);
      const assignment = await insertEnhancedAssignment({
        due_date: assignmentDate.toISOString(),
        class_id,
        allow_not_graded_submissions: false,
        rubricConfig: effectiveRubricConfig
      });
      assignments.push(assignment);

      // Track rubric structure for summary
      const rubricSummary = {
        title: assignment.title,
        parts: assignment.rubricParts?.length || 0,
        totalChecks: assignment.rubricChecks?.length || 0,
        partNames: assignment.rubricParts?.map((p: { name: string }) => p.name).join(", ") || "Unknown"
      };
      assignmentRubricSummaries.push(rubricSummary);

      if ((i + 1) % 5 === 0) {
        console.log(`  ✓ Created ${i + 1} assignments with enhanced rubrics...`);
      }
    }

    console.log(`✓ Created ${assignments.length} assignments with diverse rubric structures`);

    // Log rubric diversity summary
    console.log("\n📋 Rubric Structure Summary:");
    const uniquePartCombinations = new Set(assignmentRubricSummaries.map((s) => s.partNames));
    console.log(`   Unique rubric part combinations: ${uniquePartCombinations.size}`);
    console.log(
      `   Total rubric checks created: ${assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0)}`
    );
    console.log(
      `   Average checks per assignment: ${Math.round(assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0) / assignments.length)}`
    );

    // Show sample rubric structures
    console.log("\n📝 Sample Rubric Structures:");
    assignmentRubricSummaries.slice(0, 3).forEach((summary, idx) => {
      console.log(`   ${idx + 1}. ${summary.title}: ${summary.parts} parts, ${summary.totalChecks} checks`);
      console.log(`      Parts: ${summary.partNames}`);
    });

    // Create submissions using TestingUtils
    console.log("\n📝 Creating submissions and reviews...");
    const submissionData: Array<{
      submission_id: number;
      assignment: (typeof assignments)[0];
      student: TestingUser;
    }> = [];

    // Pick students who will get extensions (10% of students)
    console.log("\n⏰ Selecting students for extensions...");
    const studentsWithExtensions = new Set<string>();
    const numStudentsForExtensions = Math.floor(students.length * 0.1); // 10% of students get extensions
    const shuffledStudents = [...students].sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(numStudentsForExtensions, shuffledStudents.length); i++) {
      studentsWithExtensions.add(shuffledStudents[i].private_profile_id);
    }
    console.log(`✓ Selected ${studentsWithExtensions.size} students for extensions`);

    for (const assignment of assignments) {
      const isRecentlyDue = new Date(assignment.due_date as string) < now;
      // Take all students but drop 1% randomly
      const submissionsForThisAssignment: Array<{ submission_id: number; student: TestingUser }> = [];

      for (const student of students) {
        // 95% chance student submitted (using TestingUtils)
        if (Math.random() < 0.95) {
          const { submission_id } = await insertPreBakedSubmission({
            student_profile_id: student.private_profile_id,
            assignment_id: assignment.id,
            class_id: class_id
          });

          submissionData.push({ submission_id, assignment, student });
          submissionsForThisAssignment.push({ submission_id, student });
        }
      }

      // For recently due assignments, update reviews (but skip students with extensions)
      if (isRecentlyDue && submissionsForThisAssignment.length > 0) {
        let reviewsUpdated = 0;
        for (const { submission_id, student } of submissionsForThisAssignment) {
          // Skip students who have extensions - their work is not yet graded
          if (studentsWithExtensions.has(student.private_profile_id)) {
            continue;
          }

          // Get the grading_review_id from the submission
          const { data: submissionInfo } = await supabase
            .from("submissions")
            .select("grading_review_id")
            .eq("id", submission_id)
            .single();

          if (submissionInfo?.grading_review_id) {
            const isCompleted = Math.random() < 0.95; // 95% chance review is completed
            const grader = graders[Math.floor(Math.random() * graders.length)];
            await gradeSubmission(submissionInfo.grading_review_id, grader.private_profile_id, isCompleted);
            reviewsUpdated++;
          }
        }
        if (reviewsUpdated > 0) {
          console.log(
            `  ✓ Updated ${reviewsUpdated} reviews for ${assignment.title} (skipped ${submissionsForThisAssignment.filter((s) => studentsWithExtensions.has(s.student.private_profile_id)).length} students with extensions)`
          );
        }
      }
    }

    // Create due date exceptions (extensions) for selected students
    console.log("\n⏰ Creating due date extensions...");
    let extensionsCreated = 0;
    for (const { assignment, student } of submissionData) {
      // Only create extensions for students who were selected for extensions
      if (studentsWithExtensions.has(student.private_profile_id)) {
        await createDueDateException(assignment.id, student.private_profile_id, class_id, 5000);
        extensionsCreated++;
      }
    }
    console.log(`✓ Created ${extensionsCreated} due date extensions`);

    // Create regrade requests
    console.log("\n🔄 Creating regrade requests...");
    let regradeCount = 0;
    const statuses: Array<"opened" | "resolved" | "closed"> = ["opened", "resolved", "closed"];

    // Create regrade requests for 20% of submissions at random
    const numRegradeRequests = Math.max(1, Math.floor(submissionData.length * 0.2));
    // Shuffle the submissionData array
    const shuffledSubmissions = submissionData
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, numRegradeRequests);

    for (const { submission_id, assignment, student } of shuffledSubmissions) {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const grader = graders[Math.floor(Math.random() * graders.length)];
      const rubric_check_id = assignment.rubricChecks[Math.random() < 0.5 ? 2 : 3].id;
      await createRegradeRequest(
        submission_id,
        assignment.id,
        student.private_profile_id,
        grader.private_profile_id,
        rubric_check_id,
        class_id,
        status
      );
      regradeCount++;
    }
    console.log(`✓ Created ${regradeCount} regrade requests`);

    console.log("\n🎉 Database seeding completed successfully!");
    console.log(`\n📊 Summary:`);
    console.log(`   Class ID: ${class_id}`);
    console.log(`   Class Name: ${testClass.name}`);
    console.log(`   Assignments: ${assignments.length}`);
    console.log(`   Students: ${students.length}`);
    console.log(`   Graders: ${graders.length}`);
    console.log(`   Class Sections: ${classSections.length}`);
    console.log(`   Lab Sections: ${labSections.length}`);
    console.log(`   Student Tag Types: ${studentTagTypes.length}`);
    console.log(`   Grader Tag Types: ${graderTagTypes.length}`);
    console.log(`   Submissions: ${submissionData.length}`);
    console.log(`   Extensions: ${extensionsCreated}`);
    console.log(`   Regrade Requests: ${regradeCount}`);
    console.log(`   Total Rubric Checks: ${assignmentRubricSummaries.reduce((sum, s) => sum + s.totalChecks, 0)}`);
    console.log(`   Unique Rubric Combinations: ${uniquePartCombinations.size}`);

    console.log(`\n🏫 Section Details:`);
    classSections.forEach((section) => console.log(`   Class: ${section.name}`));
    labSections.forEach((section) => console.log(`   Lab: ${section.name}`));

    console.log(`\n🏷️ Tag Type Details:`);
    studentTagTypes.forEach((tagType) => console.log(`   Student: ${tagType.name} (${tagType.color})`));
    graderTagTypes.forEach((tagType) => console.log(`   Grader: ${tagType.name} (${tagType.color})`));

    console.log(`\n🔐 Instructor Login Credentials:`);
    console.log(`   Email: ${instructor.email}`);
    console.log(`   Password: ${instructor.password}`);
    console.log(`\n🔗 View the instructor dashboard at: /course/${class_id}`);
  } catch (error) {
    console.error("❌ Error seeding database:", error);
    process.exit(1);
  }
}

// Examples of different invocation patterns:

// Large-scale example (default)
export async function runLargeScale() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 100,
    numGraders: 50,
    numAssignments: 40,
    firstAssignmentDate: subDays(now, 60), // 60 days in the past
    lastAssignmentDate: addDays(now, 50), // 50 days in the future
    rubricConfig: {
      minPartsPerAssignment: 3,
      maxPartsPerAssignment: 5,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 4
    },
    sectionsAndTagsConfig: {
      numClassSections: 10,
      numLabSections: 10,
      numStudentTags: 10,
      numGraderTags: 20
    }
  });
}

// Small-scale example for testing
async function runSmallScale() {
  const now = new Date();

  await seedInstructorDashboardData({
    numStudents: 50,
    numGraders: 5,
    numAssignments: 5,
    firstAssignmentDate: subDays(now, 30), // 30 days in the past
    lastAssignmentDate: addDays(now, 30), // 30 days in the future
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    },
    sectionsAndTagsConfig: {
      numClassSections: 2,
      numLabSections: 2,
      numStudentTags: 2,
      numGraderTags: 4
    }
  });
}

// Run the large-scale example by default
// To run small-scale instead, change this to: runSmallScale()
async function main() {
  //   await runLargeScale();
  // Uncomment below and comment above to run small scale:
  await runSmallScale();
}

main();
