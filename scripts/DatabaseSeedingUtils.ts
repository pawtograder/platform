/* eslint-disable no-console, @typescript-eslint/no-unused-vars */
/**
 * DatabaseSeedingUtils - A comprehensive database seeding utility for the Pawtograder platform
 *
 * Key Features:
 * - User Recycling: Automatically finds and reuses existing @pawtograder.net users to avoid
 *   hitting auth rate limits and speed up seeding operations
 * - Rate Limiting: Configurable rate limits for different database operations to prevent
 *   overwhelming the database
 * - Performance Tracking: Detailed metrics on insertion rates and performance
 * - Flexible Configuration: Builder pattern for easy configuration of seeding parameters
 *
 * User Recycling:
 * The system looks for existing users with emails matching the pattern:
 * {role}-{uuid}-{RECYCLE_USERS_KEY}-demo@pawtograder.net
 *
 * Where RECYCLE_USERS_KEY defaults to "demo" but can be set via environment variable.
 * This allows multiple test environments to have separate user pools.
 */
import { Database } from "@/utils/supabase/SupabaseTypes";
import { faker } from "@faker-js/faker";
import { addDays } from "date-fns";
import { webcrypto } from "crypto";

import {
  createClass,
  createUserInClass,
  supabase,
  TEST_HANDOUT_REPO,
  type TestingUser
} from "../tests/e2e/TestingUtils";
import { Assignment } from "@/utils/supabase/DatabaseTypes";
import { DEFAULT_RATE_LIMITS, RateLimitConfig, RateLimitManager } from "@/tests/generator/GenerationUtils";

// Ensure crypto is available globally for Node.js environments
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = webcrypto as Crypto;
}

// ============================
// CONFIGURATION INTERFACES
// ============================

export interface RubricConfig {
  minPartsPerAssignment: number;
  maxPartsPerAssignment: number;
  minCriteriaPerPart: number;
  maxCriteriaPerPart: number;
  minChecksPerCriteria: number;
  maxChecksPerCriteria: number;
}

export interface SectionsAndTagsConfig {
  numClassSections: number;
  numLabSections: number;
  numStudentTags: number;
  numGraderTags: number;
}

export interface LabAssignmentConfig {
  numLabAssignments: number;
  minutesDueAfterLab: number;
}

export interface GroupAssignmentConfig {
  numGroupAssignments: number;
  numLabGroupAssignments: number;
}

export interface HelpRequestConfig {
  numHelpRequests: number;
  minRepliesPerRequest: number;
  maxRepliesPerRequest: number;
  maxMembersPerRequest: number;
}

export interface DiscussionConfig {
  postsPerTopic: number;
  maxRepliesPerPost: number;
}

export interface SeedingConfiguration {
  numStudents: number;
  numGraders: number;
  numInstructors: number;
  numAssignments: number;
  firstAssignmentDate: Date;
  lastAssignmentDate: Date;
  numManualGradedColumns?: number;
  rubricConfig?: RubricConfig;
  sectionsAndTagsConfig?: SectionsAndTagsConfig;
  labAssignmentConfig?: LabAssignmentConfig;
  groupAssignmentConfig?: GroupAssignmentConfig;
  helpRequestConfig?: HelpRequestConfig;
  discussionConfig?: DiscussionConfig;
  gradingScheme?: "current" | "specification";
  className?: string;
  recycleUsers?: boolean; // Whether to recycle existing users with @pawtograder.net emails
}

// ============================
// USER RECYCLING CONFIGURATION
// ============================

const RECYCLE_USERS_KEY = process.env.RECYCLE_USERS_KEY || "demo";

// ============================
// CONSTANTS FOR DATA GENERATION
// ============================

// Sample help request messages for realistic data
const HELP_REQUEST_TEMPLATES = [
  "My algorithm keeps timing out on large datasets - any optimization tips?",
  "Having trouble with memory management in my implementation",
  "Getting a stack overflow error when recursion depth gets too high",
  "My sorting algorithm works but seems inefficient - suggestions for improvement?",
  "Struggling with edge cases in my binary search implementation",
  "Need help debugging this segmentation fault in my C++ code",
  "My program compiles but gives wrong output for certain test cases",
  "Having issues with concurrent programming - thread safety concerns",
  "My database query is running too slowly, need performance optimization",
  "Getting unexpected behavior with pointer arithmetic",
  "My neural network isn't converging - what hyperparameters should I adjust?",
  "Need help understanding the requirements for the dynamic programming solution",
  "My unit tests are failing intermittently - not sure why",
  "Having trouble with the graph traversal algorithm implementation",
  "My web app crashes under high load - need scalability advice",
  "Getting strange compiler errors that I can't figure out",
  "Need help with debugging this race condition",
  "My machine learning model is overfitting - how to regularize?",
  "Having issues with API integration and error handling",
  "My algorithm works for small inputs but fails for large ones"
];

const HELP_REQUEST_REPLIES = [
  "Have you tried using memoization to optimize your recursive calls?",
  "Consider using a different data structure - maybe a hash table would help?",
  "Try profiling your code to identify the bottleneck",
  "You might want to implement tail recursion optimization",
  "Check if you're creating unnecessary objects in your loop",
  "Have you considered using a more efficient sorting algorithm?",
  "Try adding some debug prints to trace the execution flow",
  "Make sure you're handling boundary conditions correctly",
  "Consider using parallel processing for large datasets",
  "You might need to increase the stack size for deep recursion",
  "Try breaking down the problem into smaller subproblems",
  "Check your loop invariants and termination conditions",
  "Consider using a different approach - maybe iterative instead of recursive?",
  "Make sure you're not accessing memory out of bounds",
  "Try using a debugger to step through your code line by line",
  "Have you tested with edge cases like empty input or single elements?",
  "Consider optimizing your space complexity if time complexity is already good",
  "You might want to use a more appropriate design pattern here",
  "Try caching expensive computations to avoid redundant work",
  "Make sure your algorithm has the correct time complexity"
];

// ============================
// HELPER FUNCTIONS
// ============================

// Helper function to chunk arrays into smaller batches
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Get a unique test run prefix for repositories
export function getTestRunPrefix(randomSuffix?: string) {
  const suffix = randomSuffix ?? Math.random().toString(36).substring(2, 6);
  const test_run_batch = new Date().toISOString().split("T")[0] + "#" + suffix;
  const workerIndex = process.env.TEST_WORKER_INDEX || "";
  return `e2e-${test_run_batch}-${workerIndex}`;
}

// Helper function to determine optimal group size for number of students
export function calculateGroupSize(numStudents: number): number {
  // Try to find the best group size that divides evenly
  const possibleSizes = [2, 3, 4, 5];

  for (const size of possibleSizes) {
    if (numStudents % size === 0) {
      return size;
    }
  }

  // If no perfect division, use the size that leaves the smallest remainder
  let bestSize = 2;
  let smallestRemainder = numStudents % 2;

  for (const size of possibleSizes) {
    const remainder = numStudents % size;
    if (remainder < smallestRemainder) {
      smallestRemainder = remainder;
      bestSize = size;
    }
  }

  return bestSize;
}

// Helper function to generate rubric structure
function generateRubricStructure(config: RubricConfig) {
  const partTemplates = [
    "Code Quality",
    "Algorithm Design",
    "Testing",
    "Documentation",
    "Style",
    "Functionality",
    "Error Handling",
    "Performance"
  ];

  const criteriaTemplates = [
    "Correctness",
    "Efficiency",
    "Clarity",
    "Completeness",
    "Organization",
    "Best Practices",
    "Edge Cases",
    "Maintainability"
  ];

  const checkTemplates = [
    "Excellent",
    "Good",
    "Satisfactory",
    "Needs Improvement",
    "Poor",
    "Complete",
    "Mostly Complete",
    "Partially Complete",
    "Incomplete",
    "Clear",
    "Mostly Clear",
    "Somewhat Clear",
    "Unclear"
  ];

  const numParts = faker.number.int({
    min: config.minPartsPerAssignment,
    max: config.maxPartsPerAssignment
  });

  return Array.from({ length: numParts }, (_, partIndex) => {
    const numCriteria = faker.number.int({
      min: config.minCriteriaPerPart,
      max: config.maxCriteriaPerPart
    });

    return {
      name: partTemplates[partIndex % partTemplates.length],
      description: `${partTemplates[partIndex % partTemplates.length]} evaluation`,
      ordinal: partIndex,
      criteria: Array.from({ length: numCriteria }, (_, criteriaIndex) => {
        const numChecks = faker.number.int({
          min: config.minChecksPerCriteria,
          max: config.maxChecksPerCriteria
        });

        return {
          name: criteriaTemplates[criteriaIndex % criteriaTemplates.length],
          description: `${criteriaTemplates[criteriaIndex % criteriaTemplates.length]} assessment`,
          ordinal: criteriaIndex,
          total_points: faker.number.int({ min: 5, max: 20 }),
          checks: Array.from({ length: numChecks }, (_, checkIndex) => ({
            name: checkTemplates[checkIndex % checkTemplates.length],
            ordinal: checkIndex,
            points: faker.number.int({ min: 1, max: 5 }),
            is_annotation: Math.random() < 0.3,
            is_comment_required: Math.random() < 0.4,
            is_required: Math.random() < 0.7
          }))
        };
      })
    };
  });
}

// Helper function to define tag types (name/color combinations)
export function defineTagTypes(prefix: string, numTagTypes: number) {
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

// Helper function to find existing users with @pawtograder.net emails
export async function findExistingPawtograderUsers(): Promise<{
  instructors: TestingUser[];
  graders: TestingUser[];
  students: TestingUser[];
}> {
  // Query public.users for existing @pawtograder.net users
  const { data: existingUsers, error: usersError } = await supabase
    .from("users")
    .select(
      "*, user_roles(role, private_profile_id, public_profile_id, profiles_private:profiles!private_profile_id(name), profiles_public:profiles!public_profile_id(name))"
    )
    .like("email", `%${RECYCLE_USERS_KEY}-demo@pawtograder.net`);

  if (usersError) {
    console.error(`Failed to fetch existing users: ${usersError.message}`);
    throw new Error(`Failed to fetch existing users: ${usersError.message}`);
  }

  const pawtograderUsers = existingUsers;

  if (pawtograderUsers.length === 0) {
    console.log("No existing *demo@pawtograder.net users found");
    return { instructors: [], graders: [], students: [] };
  }

  console.log(`Found ${pawtograderUsers.length} existing *demo@pawtograder.net users`);

  // Convert to TestingUser format
  const convertToTestingUser = (
    user: { user_id: string; email?: string | null },
    userRole: {
      profiles_private?: { name: string | null };
      profiles_public?: { name: string | null };
      private_profile_id: string;
      public_profile_id: string;
    }
  ): TestingUser => ({
    private_profile_name: userRole.profiles_private?.name || "Unknown",
    public_profile_name: userRole.profiles_public?.name || "Unknown",
    email: user.email || "",
    password: process.env.TEST_PASSWORD || "change-it",
    user_id: user.user_id,
    private_profile_id: userRole.private_profile_id,
    public_profile_id: userRole.public_profile_id,
    class_id: -1 // Will be updated when enrolled in class
  });

  const result = { instructors: [] as TestingUser[], graders: [] as TestingUser[], students: [] as TestingUser[] };

  for (const user of pawtograderUsers) {
    if (!user.user_roles || user.user_roles.length === 0) continue;

    const testingUser = convertToTestingUser(user, user.user_roles[0]);

    // Categorize by email pattern (instructor-, grader-, student-)
    if (user.email && user.email.startsWith("instructor-")) {
      result.instructors.push(testingUser);
    } else if (user.email && user.email.startsWith("grader-")) {
      result.graders.push(testingUser);
    } else if (user.email && user.email.startsWith("student-")) {
      result.students.push(testingUser);
    }
  }

  return result;
}

// Helper function to enroll existing users in a class
export async function enrollExistingUserInClass(
  user: TestingUser,
  class_id: number,
  rateLimitManager: RateLimitManager
): Promise<TestingUser> {
  const { data: privateProfile, error: privateProfileError } = await rateLimitManager.trackAndLimit("profiles", () =>
    supabase
      .from("profiles")
      .insert({
        name: user.private_profile_name,
        class_id: class_id,
        is_private_profile: true
      })
      .select("id")
  );

  if (privateProfileError) {
    throw new Error(`Failed to create private profile: ${privateProfileError.message}`);
  }

  // Create new public profile
  const { data: publicProfile, error: publicProfileError } = await rateLimitManager.trackAndLimit("profiles", () =>
    supabase
      .from("profiles")
      .insert({
        name: user.public_profile_name,
        class_id: class_id,
        is_private_profile: false
      })
      .select("id")
  );

  if (publicProfileError) {
    throw new Error(`Failed to create public profile: ${publicProfileError.message}`);
  }

  // Determine role based on email pattern
  const role = user.email.startsWith("instructor-")
    ? "instructor"
    : user.email.startsWith("grader-")
      ? "grader"
      : "student";

  // Insert user role with new profiles
  const { error: userRoleError } = await rateLimitManager.trackAndLimit("user_roles", () =>
    supabase
      .from("user_roles")
      .insert({
        user_id: user.user_id,
        role: role,
        class_id: class_id,
        private_profile_id: privateProfile[0].id,
        public_profile_id: publicProfile[0].id
      })
      .select("user_id")
  );

  if (userRoleError) {
    throw new Error(`Failed to create user role: ${userRoleError.message}`);
  }

  // Return updated user with new profile IDs and class_id
  return {
    ...user,
    class_id,
    private_profile_id: privateProfile[0].id,
    public_profile_id: publicProfile[0].id
  };
}

// ============================
// DATABASE SEEDER CLASS
// ============================

export class DatabaseSeeder {
  protected rateLimitManager: RateLimitManager;
  protected rateLimits: Record<string, RateLimitConfig>;
  private config: Partial<SeedingConfiguration> = {};
  private repoCounter = 0;

  constructor(customRateLimits?: Record<string, RateLimitConfig>) {
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...customRateLimits };
    this.rateLimitManager = new RateLimitManager(this.rateLimits);

    // Set faker seed for reproducible results
    faker.seed(100);
  }

  // Builder pattern methods
  withStudents(count: number): this {
    this.config.numStudents = count;
    return this;
  }

  withGraders(count: number): this {
    this.config.numGraders = count;
    return this;
  }

  withInstructors(count: number): this {
    this.config.numInstructors = count;
    return this;
  }

  withAssignments(count: number): this {
    this.config.numAssignments = count;
    return this;
  }

  withAssignmentDateRange(firstDate: Date, lastDate: Date): this {
    this.config.firstAssignmentDate = firstDate;
    this.config.lastAssignmentDate = lastDate;
    return this;
  }

  withManualGradedColumns(count: number): this {
    this.config.numManualGradedColumns = count;
    return this;
  }

  withRubricConfig(config: RubricConfig): this {
    this.config.rubricConfig = config;
    return this;
  }

  withSectionsAndTags(config: SectionsAndTagsConfig): this {
    this.config.sectionsAndTagsConfig = config;
    return this;
  }

  withLabAssignments(config: LabAssignmentConfig): this {
    this.config.labAssignmentConfig = config;
    return this;
  }

  withGroupAssignments(config: GroupAssignmentConfig): this {
    this.config.groupAssignmentConfig = config;
    return this;
  }

  withHelpRequests(config: HelpRequestConfig): this {
    this.config.helpRequestConfig = config;
    return this;
  }

  withDiscussions(config: DiscussionConfig): this {
    this.config.discussionConfig = config;
    return this;
  }

  withGradingScheme(scheme: "current" | "specification"): this {
    this.config.gradingScheme = scheme;
    return this;
  }

  withClassName(name: string): this {
    this.config.className = name;
    return this;
  }

  withUserRecycling(enabled: boolean = true): this {
    this.config.recycleUsers = enabled;
    return this;
  }

  // Method to validate and get complete configuration
  protected getCompleteConfiguration(): SeedingConfiguration {
    // Validate required fields
    if (!this.config.numStudents) throw new Error("Number of students is required");
    if (!this.config.numGraders) throw new Error("Number of graders is required");
    if (!this.config.numInstructors) throw new Error("Number of instructors is required");
    if (!this.config.numAssignments) throw new Error("Number of assignments is required");
    if (!this.config.firstAssignmentDate) throw new Error("First assignment date is required");
    if (!this.config.lastAssignmentDate) throw new Error("Last assignment date is required");

    // Apply defaults
    const defaultRubricConfig: RubricConfig = {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    };

    const defaultSectionsAndTagsConfig: SectionsAndTagsConfig = {
      numClassSections: 2,
      numLabSections: 2,
      numStudentTags: 2,
      numGraderTags: 4
    };

    const defaultLabAssignmentConfig: LabAssignmentConfig = {
      numLabAssignments: Math.floor(this.config.numAssignments * 0.3),
      minutesDueAfterLab: 1440
    };

    const effectiveLabConfig = this.config.labAssignmentConfig || defaultLabAssignmentConfig;

    const defaultGroupAssignmentConfig: GroupAssignmentConfig = {
      numGroupAssignments: Math.floor((this.config.numAssignments - effectiveLabConfig.numLabAssignments) * 0.4),
      numLabGroupAssignments: Math.floor(effectiveLabConfig.numLabAssignments * 0.5)
    };

    return {
      numStudents: this.config.numStudents,
      numGraders: this.config.numGraders,
      numInstructors: this.config.numInstructors,
      numAssignments: this.config.numAssignments,
      firstAssignmentDate: this.config.firstAssignmentDate,
      lastAssignmentDate: this.config.lastAssignmentDate,
      numManualGradedColumns: this.config.numManualGradedColumns || 0,
      rubricConfig: this.config.rubricConfig || defaultRubricConfig,
      sectionsAndTagsConfig: this.config.sectionsAndTagsConfig || defaultSectionsAndTagsConfig,
      labAssignmentConfig: this.config.labAssignmentConfig || defaultLabAssignmentConfig,
      groupAssignmentConfig: this.config.groupAssignmentConfig || defaultGroupAssignmentConfig,
      helpRequestConfig: this.config.helpRequestConfig,
      discussionConfig: this.config.discussionConfig,
      gradingScheme: this.config.gradingScheme || "current",
      className: this.config.className || "Test Class",
      recycleUsers: this.config.recycleUsers !== false // Default to true unless explicitly disabled
    };
  }

  // Main seeding method
  async seed(): Promise<void> {
    const config = this.getCompleteConfiguration();

    console.log("🌱 Starting database seeding with DatabaseSeeder...\n");

    // Display rate limiting configuration
    this.displayRateLimitingConfiguration();
    this.displaySeedingConfiguration(config);

    try {
      // Create test class
      const testClass = await createClass({ name: config.className });
      const class_id = testClass.id;
      console.log(`✓ Created test class: ${testClass.name} (ID: ${class_id})`);

      // Create users
      const { instructors, graders, students } = await this.createUsers(config, class_id);

      // Create class structure (sections, tags)
      const { classSections, labSections, studentTagTypes, graderTagTypes } = await this.createClassStructure(
        config,
        class_id,
        instructors
      );

      // Assign users to sections and tags
      await this.assignUsersToSectionsAndTags(
        students,
        graders,
        classSections,
        labSections,
        studentTagTypes,
        graderTagTypes,
        class_id,
        instructors[0].user_id
      );

      // Create grader conflicts
      await this.createGraderConflicts(graders, students, class_id, instructors[0].private_profile_id);

      // Create discussion threads if configured
      if (config.discussionConfig) {
        await this.createDiscussionThreads(config.discussionConfig, class_id, students, instructors, graders);
      }

      // // Create assignments and submissions
      const assignments = await this.createAssignments(config, class_id, students);
      const submissionData = await this.createSubmissions(assignments, students, class_id);

      // Create workflow events and errors
      await this.createWorkflowEvents(submissionData, class_id);
      await this.createWorkflowErrors(submissionData, class_id);

      // Grade submissions
      await this.gradeSubmissions(submissionData, graders, students);

      // const class_id = 208;
      // const { data: testClassData } = await supabase.from("classes").select("*").eq("id", class_id);
      // const testClass = testClassData?.[0];
      // if (!testClass) {
      //   console.error("Test class not found");
      //   return;
      // }

      // const { data: gradersData } = await supabase
      //   .from("user_roles")
      //   .select(
      //     "*, private_profile:profiles!private_profile_id(*),public_profile:profiles!public_profile_id(*),users(email)"
      //   )
      //   .eq("class_id", class_id)
      //   .eq("role", "grader");
      // const graders =
      //   gradersData?.map((grader) => ({
      //     private_profile_id: grader.private_profile.id || "",
      //     public_profile_id: grader.public_profile.id || "",
      //     email: grader.users.email || "",
      //     password: "",
      //     class_id: class_id,
      //     user_id: grader.user_id || "",
      //     private_profile_name: grader.private_profile.name || "",
      //     public_profile_name: grader.public_profile.name || ""
      //   })) || [];
      // const { data: studentsData } = await supabase
      //   .from("user_roles")
      //   .select(
      //     "*, private_profile:profiles!private_profile_id(*),public_profile:profiles!public_profile_id(*),users(email)"
      //   )
      //   .eq("class_id", class_id)
      //   .eq("role", "student");
      // const students =
      //   studentsData?.map((student) => ({
      //     private_profile_id: student.private_profile.id || "",
      //     public_profile_id: student.public_profile.id || "",
      //     private_profile_name: student.private_profile.name || "",
      //     public_profile_name: student.public_profile.name || "",
      //     email: student.users.email || "",
      //     password: "",
      //     class_id: class_id,
      //     user_id: student.user_id || ""
      //   })) || [];
      // const { data: instructorsData } = await supabase
      //   .from("user_roles")
      //   .select(
      //     "*, private_profile:profiles!private_profile_id(*),public_profile:profiles!public_profile_id(*),users(email)"
      //   )
      //   .eq("class_id", class_id)
      //   .eq("role", "instructor");
      // const instructors =
      //   instructorsData?.map((instructor) => ({
      //     private_profile_id: instructor.private_profile.id || "",
      //     public_profile_id: instructor.public_profile.id || "",
      //     email: instructor.users.email || "",
      //     private_profile_name: instructor.private_profile.name || "",
      //     public_profile_name: instructor.public_profile.name || "",
      //     password: "",
      //     class_id: class_id,
      //     user_id: instructor.user_id || ""
      //   })) || [];
      // if (!instructors) {
      //   console.error("Instructors not found");
      //   return;
      // }

      // const { data: submissionData } = await supabase.from("submissions").select("*").eq("class_id", class_id);
      // if (!submissionData) {
      //   console.error("Submissions not found");
      //   return;
      // }
      // const { data: assignments } = await supabase.from("assignments").select("*").eq("class_id", class_id);
      // if (!assignments) {
      //   console.error("Assignments not found");
      //   return;
      // }
      // const submissionWithProfileData: Array<{
      //   submission_id: number;
      //   assignment: { id: number; due_date: string };
      //   student?: TestingUser;
      //   group?: { id: number; name: string; memberCount: number; members: string[] };
      // }> = [];
      // for (const assignment of assignments) {
      //   const thisAssignmentSubmissions = submissionData.filter(
      //     (submission) => submission.assignment_id === assignment.id
      //   );
      //   const { data: groupsWithMembers } = await supabase
      //     .from("assignment_groups")
      //     .select("*, assignment_groups_members(profiles!profile_id(*))")
      //     .eq("assignment_id", assignment.id);
      //   for (const submission of thisAssignmentSubmissions) {
      //     const submissionWithProfile = {
      //       submission_id: submission.id,
      //       assignment: { id: assignment.id, due_date: assignment.due_date },
      //       student: students.find((student) => student.private_profile_id === submission.profile_id),
      //       group:
      //         submission.assignment_group_id &&
      //         groupsWithMembers?.find((group) => group.id === submission.assignment_group_id)
      //           ? {
      //               id: submission.assignment_group_id,
      //               members:
      //                 groupsWithMembers
      //                   .find((group) => group.id === submission.assignment_group_id)
      //                   ?.assignment_groups_members.map((member) => member.profiles.name || "") || [],
      //               memberCount:
      //                 groupsWithMembers.find((group) => group.id === submission.assignment_group_id)
      //                   ?.assignment_groups_members.length || 0,
      //               name: groupsWithMembers.find((group) => group.id === submission.assignment_group_id)?.name || ""
      //             }
      //           : undefined
      //     };
      //     submissionWithProfileData.push(submissionWithProfile);
      //   }
      // }

      // Create extensions and regrade requests
      await this.createExtensionsAndRegradeRequests(submissionData, assignments, graders, class_id);

      // Create gradebook columns
      await this.createGradebookColumns(config, class_id, students, assignments);

      // Create help requests if configured
      if (config.helpRequestConfig) {
        await this.createHelpRequests(config.helpRequestConfig, class_id, students, instructors, graders);
      }

      // Display final summary
      this.displayFinalSummary(
        { id: testClass.id, name: testClass.name || "Test Class" },
        config,
        assignments,
        submissionData,
        instructors,
        graders,
        students
      );
    } catch (error) {
      console.error("❌ Error seeding database:", error);
      throw error;
    } finally {
      // Always show performance summary
      this.rateLimitManager.finalizePerformanceTracking();
      this.rateLimitManager.displayPerformanceSummary(this.rateLimits);
    }
  }

  protected displayRateLimitingConfiguration(): void {
    console.log("⚡ RATE LIMITING CONFIGURATION:");
    console.log(
      "Data Type".padEnd(25) + "Max/sec".padEnd(10) + "Batch".padEnd(8) + "Batches/sec".padEnd(12) + "Description"
    );
    console.log("-".repeat(90));
    Object.entries(this.rateLimits).forEach(([dataType, config]) => {
      const batchSize = config.batchSize ? config.batchSize.toString() : "N/A";
      const batchesPerSec = config.batchSize ? (config.maxInsertsPerSecond / config.batchSize).toFixed(2) : "N/A";

      console.log(
        dataType.padEnd(25) +
          config.maxInsertsPerSecond.toString().padEnd(10) +
          batchSize.padEnd(8) +
          batchesPerSec.padEnd(12) +
          config.description
      );
    });
    console.log("");
  }

  protected displaySeedingConfiguration(config: SeedingConfiguration): void {
    console.log(`📊 SEEDING CONFIGURATION:`);
    console.log(`   Students: ${config.numStudents}`);
    console.log(`   Graders: ${config.numGraders}`);
    console.log(`   Instructors: ${config.numInstructors}`);
    console.log(`   Assignments: ${config.numAssignments}`);
    console.log(`   Lab Assignments: ${config.labAssignmentConfig!.numLabAssignments}`);
    console.log(`   Group Assignments: ${config.groupAssignmentConfig!.numGroupAssignments}`);
    console.log(`   Lab Group Assignments: ${config.groupAssignmentConfig!.numLabGroupAssignments}`);
    console.log(`   Manual Graded Columns: ${config.numManualGradedColumns}`);
    console.log(`   First Assignment: ${config.firstAssignmentDate.toISOString().split("T")[0]}`);
    console.log(`   Last Assignment: ${config.lastAssignmentDate.toISOString().split("T")[0]}`);
    console.log(`   Grading Scheme: ${config.gradingScheme}`);
    console.log(`   Recycle Users: ${config.recycleUsers ? "✓ Enabled" : "✗ Disabled"}`);
    if (config.helpRequestConfig) {
      console.log(`   Help Requests: ${config.helpRequestConfig.numHelpRequests}`);
    }
    if (config.discussionConfig) {
      console.log(`   Discussion Posts per Topic: ${config.discussionConfig.postsPerTopic}`);
    }
    console.log("");
  }

  protected displayFinalSummary(
    testClass: { id: number; name: string },
    config: SeedingConfiguration,
    assignments: Array<{ id: number; title: string }>,
    submissionData: Array<{ submission_id: number }>,
    instructors: TestingUser[],
    graders: TestingUser[],
    students: TestingUser[]
  ): void {
    console.log("\n🎉 Database seeding completed successfully!");
    console.log(`\n📊 Summary:`);
    console.log(`   Class ID: ${testClass.id}`);
    console.log(`   Class Name: ${testClass.name}`);
    console.log(`   Assignments: ${assignments.length}`);
    console.log(`   Students: ${students.length}`);
    console.log(`   Graders: ${graders.length}`);
    console.log(`   Instructors: ${instructors.length}`);
    console.log(`   Submissions: ${submissionData.length}`);
    console.log(`   Grading Scheme: ${config.gradingScheme}`);

    console.log(`\n🔐 Login Credentials:`);
    console.log(`   Instructor: ${instructors[0].email} / ${instructors[0].password}`);
    if (graders.length > 0) {
      console.log(`   Grader: ${graders[0].email} / ${graders[0].password}`);
    }
    if (students.length > 0) {
      console.log(`   Student: ${students[0].email} / ${students[0].password}`);
    }

    console.log(`\n🔗 View the instructor dashboard at: /course/${testClass.id}`);
  }

  // Create users with optional recycling optimization
  private async createUsers(config: SeedingConfiguration, class_id: number) {
    console.log("\n👥 Creating users...");

    let existingUsers = {
      instructors: [] as TestingUser[],
      graders: [] as TestingUser[],
      students: [] as TestingUser[]
    };

    // Find existing users first if recycling is enabled
    if (config.recycleUsers) {
      console.log("🔄 Finding existing @pawtograder.net users for recycling...");
      existingUsers = await findExistingPawtograderUsers();
      console.log(
        `Found ${existingUsers.instructors.length} existing instructors, ${existingUsers.graders.length} existing graders, ${existingUsers.students.length} existing students`
      );
    }

    // Process instructors
    console.log(
      `  Processing ${config.numInstructors} instructors (${existingUsers.instructors.length} existing + ${Math.max(0, config.numInstructors - existingUsers.instructors.length)} new)`
    );
    const existingInstructors = await Promise.all(
      existingUsers.instructors
        .slice(0, config.numInstructors)
        .map((user) => enrollExistingUserInClass(user, class_id, this.rateLimitManager))
    );

    const newInstructorsNeeded = Math.max(0, config.numInstructors - existingInstructors.length);
    const newInstructors = await Promise.all(
      Array.from({ length: newInstructorsNeeded }).map(async () => {
        const name = faker.person.fullName();
        const uuid = crypto.randomUUID();
        return await createUserInClass({
          role: "instructor",
          class_id,
          name,
          email: `instructor-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
        });
      })
    );
    const instructors = [...existingInstructors, ...newInstructors];
    console.log(
      `✓ Using ${existingInstructors.length} existing + created ${newInstructors.length} new instructors = ${instructors.length} total`
    );

    // Process graders
    console.log(
      `  Processing ${config.numGraders} graders (${existingUsers.graders.length} existing + ${Math.max(0, config.numGraders - existingUsers.graders.length)} new)`
    );
    const existingGraders = await Promise.all(
      existingUsers.graders
        .slice(0, config.numGraders)
        .map((user) => enrollExistingUserInClass(user, class_id, this.rateLimitManager))
    );

    const newGradersNeeded = Math.max(0, config.numGraders - existingGraders.length);
    const newGraders = await Promise.all(
      Array.from({ length: newGradersNeeded }).map(async () => {
        const name = faker.person.fullName();
        const uuid = crypto.randomUUID();
        return await createUserInClass({
          role: "grader",
          class_id,
          name,
          email: `grader-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
        });
      })
    );
    const graders = [...existingGraders, ...newGraders];

    const existingStudents = await Promise.all(
      existingUsers.students
        .slice(0, config.numStudents)
        .map((user) => enrollExistingUserInClass(user, class_id, this.rateLimitManager))
    );

    const newStudentsNeeded = Math.max(0, config.numStudents - existingStudents.length);
    const newStudents = await Promise.all(
      Array.from({ length: newStudentsNeeded }).map(async () => {
        const name = faker.person.fullName();
        const uuid = crypto.randomUUID();
        return await createUserInClass({
          role: "student",
          class_id,
          name,
          email: `student-${uuid}-${RECYCLE_USERS_KEY}-demo@pawtograder.net`
        });
      })
    );
    const students = [...existingStudents, ...newStudents];
    console.log(
      `✓ Using ${existingStudents.length} existing + created ${newStudents.length} new students = ${students.length} total`
    );

    return { instructors, graders, students };
  }

  private async createClassStructure(config: SeedingConfiguration, class_id: number, instructors: TestingUser[]) {
    console.log("\n🏫 Creating class structure...");

    // Create class sections
    const sectionsData = Array.from({ length: config.sectionsAndTagsConfig!.numClassSections }, (_, i) => ({
      class_id: class_id,
      name: `Section ${String(i + 1).padStart(2, "0")}`
    }));

    const { data: classSections } = await this.rateLimitManager.trackAndLimit(
      "class_sections",
      () => supabase.from("class_sections").insert(sectionsData).select("id, name"),
      sectionsData.length
    );

    // Create lab sections
    const labSectionsData = Array.from({ length: config.sectionsAndTagsConfig!.numLabSections }, (_, i) => ({
      class_id: class_id,
      name: `Lab ${String.fromCharCode(65 + i)}`,
      day_of_week: "monday" as const,
      start_time: "09:00",
      end_time: "10:00",
      lab_leader_id: instructors[i % instructors.length].private_profile_id
    }));

    const { data: labSections } = await this.rateLimitManager.trackAndLimit(
      "lab_sections",
      () => supabase.from("lab_sections").insert(labSectionsData).select("id, name"),
      labSectionsData.length
    );

    // Define tag types
    const studentTagTypes = defineTagTypes("Student", config.sectionsAndTagsConfig!.numStudentTags);
    const graderTagTypes = defineTagTypes("Grader", config.sectionsAndTagsConfig!.numGraderTags);

    console.log(`✓ Created ${classSections?.length || 0} class sections and ${labSections?.length || 0} lab sections`);

    return {
      classSections: classSections || [],
      labSections: labSections || [],
      studentTagTypes,
      graderTagTypes
    };
  }

  // Additional placeholder methods would go here...
  // Each method would contain the extracted and adapted logic from the original file

  private async assignUsersToSectionsAndTags(
    students: TestingUser[],
    graders: TestingUser[],
    classSections: Array<{ id: number; name: string }>,
    labSections: Array<{ id: number; name: string }>,
    studentTagTypes: Array<{ name: string; color: string }>,
    graderTagTypes: Array<{ name: string; color: string }>,
    class_id: number,
    creatorId: string
  ) {
    console.log("\n🎯 Assigning users to sections and tags...");

    // Helper function to assign users to sections and tags (in parallel batches)
    const assignUsersToSectionsAndTagsHelper = async (
      users: TestingUser[],
      classSections: Array<{ id: number; name: string }>,
      labSections: Array<{ id: number; name: string }>,
      tagTypes: Array<{ name: string; color: string }>,
      class_id: number,
      userType: "student" | "grader",
      creatorId: string
    ) => {
      const batchSize = this.rateLimits["user_roles"].batchSize || 100;
      const assignments = [];

      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        // Process this batch of users in parallel
        const batchPromises = batch.map(async (user) => {
          // Randomly assign to class section (all users get one)
          const classSection = classSections[Math.floor(Math.random() * classSections.length)];

          // Randomly assign to lab section (students only, ~80% chance)
          let labSection = null;
          if (userType === "student" && Math.random() < 0.8) {
            labSection = labSections[Math.floor(Math.random() * labSections.length)];
          }

          // Update user role with section assignments
          const { error: updateError } = await this.rateLimitManager.trackAndLimit("user_roles", () =>
            supabase
              .from("user_roles")
              .update({
                class_section_id: classSection.id,
                lab_section_id: labSection?.id || null
              })
              .eq("class_id", class_id)
              .eq("private_profile_id", user.private_profile_id)
              .select("id")
          );

          if (updateError) {
            throw new Error(`Failed to assign sections to user: ${updateError.message}`);
          }

          // Randomly assign tags (30-60% chance per tag type)
          const userTags = [];
          for (const tagType of tagTypes) {
            if (Math.random() < 0.3 + Math.random() * 0.3) {
              // 30-60% chance
              // Create a tag record for this user
              const { data: tagData, error: tagError } = await this.rateLimitManager.trackAndLimit("tags", () =>
                supabase
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
              );

              if (tagError) {
                console.warn(`Failed to create tag ${tagType.name} for user: ${tagError.message}`);
              } else if (tagData && tagData.length > 0) {
                userTags.push(tagData[0]);
              }
            }
          }

          return {
            user: user.email,
            classSection: classSection.name,
            labSection: labSection?.name || null,
            tags: userTags.map((t) => t.name)
          };
        });

        // Wait for all users in this batch to complete
        const batchResults = await Promise.all(batchPromises);
        assignments.push(...batchResults);
      }

      return assignments;
    };

    // Assign users to sections and tags in parallel
    await Promise.all([
      assignUsersToSectionsAndTagsHelper(
        students,
        classSections,
        labSections,
        studentTagTypes,
        class_id,
        "student",
        creatorId
      ),
      assignUsersToSectionsAndTagsHelper(
        graders,
        classSections,
        labSections,
        graderTagTypes,
        class_id,
        "grader",
        creatorId
      )
    ]);
    console.log(`✓ Assigned ${students.length} students and ${graders.length} graders to sections and tags`);
  }

  private async createGraderConflicts(
    graders: TestingUser[],
    students: TestingUser[],
    class_id: number,
    createdByProfileId: string
  ) {
    console.log("\n⚔️ Creating grader conflicts...");

    const conflictPatterns = [2, 3]; // Grader numbers to create conflicts for
    const conflictsToInsert: Array<{
      grader_profile_id: string;
      student_profile_id: string;
      class_id: number;
      reason: string;
      created_by_profile_id: string;
    }> = [];

    // Helper function to get the user number based on their position in the list
    function getUserNumber(user: TestingUser, userList: TestingUser[]): number {
      const index = userList.findIndex((u) => u.private_profile_id === user.private_profile_id);
      return index + 1; // Use 1-based indexing
    }

    // For each conflict pattern (grader numbers 2, 3)
    for (const graderNumber of conflictPatterns) {
      // Find the grader at this position (graderNumber - 1 because we use 1-based indexing)
      const targetGrader = graders[graderNumber - 1];

      if (!targetGrader) {
        console.warn(`⚠️ Could not find grader #${graderNumber}, skipping conflicts for this grader`);
        continue;
      }

      // Find all students whose position numbers are divisible by the grader number
      const conflictedStudents = students.filter((student, studentIndex) => {
        const studentNum = studentIndex + 1; // Use 1-based indexing
        return studentNum % graderNumber === 0;
      });

      console.log(
        `   Grader #${graderNumber} conflicts with ${conflictedStudents.length} students (position divisible by ${graderNumber})`
      );

      // Create conflict records for each conflicted student
      conflictedStudents.forEach((student) => {
        const studentNum = getUserNumber(student, students);
        conflictsToInsert.push({
          grader_profile_id: targetGrader.private_profile_id,
          student_profile_id: student.private_profile_id,
          class_id: class_id,
          reason: `Automated conflict: Grader #${graderNumber} conflicts with Student #${studentNum} (${studentNum} is divisible by ${graderNumber})`,
          created_by_profile_id: createdByProfileId
        });
      });
    }

    if (conflictsToInsert.length === 0) {
      console.log("   No conflicts to insert");
      return;
    }

    // Batch insert all conflicts
    const CONFLICT_BATCH_SIZE = 100;
    const conflictChunks = chunkArray(conflictsToInsert, CONFLICT_BATCH_SIZE);

    console.log(`   Inserting ${conflictsToInsert.length} grader conflicts in ${conflictChunks.length} batches...`);

    await Promise.all(
      conflictChunks.map(async (chunk, index) => {
        const { error: conflictError } = await this.rateLimitManager.trackAndLimit(
          "grading_conflicts",
          () => supabase.from("grading_conflicts").insert(chunk).select("id"),
          chunk.length
        );

        if (conflictError) {
          throw new Error(`Failed to insert grader conflicts (batch ${index + 1}): ${conflictError.message}`);
        }
      })
    );

    console.log(`✓ Created ${conflictsToInsert.length} grader conflicts`);

    // Log summary of conflicts created
    const conflictSummary = conflictPatterns
      .map((graderNum) => {
        const conflicts = conflictsToInsert.filter((c) => c.reason.includes(`Grader #${graderNum}`));
        return `Grader #${graderNum}: ${conflicts.length} conflicts`;
      })
      .join(", ");

    console.log(`   Summary: ${conflictSummary}`);
  }

  protected async createDiscussionThreads(
    config: DiscussionConfig,
    class_id: number,
    students: TestingUser[],
    instructors: TestingUser[],
    graders: TestingUser[]
  ) {
    console.log(`\n💬 Creating discussion threads...`);
    console.log(`   Posts per topic: ${config.postsPerTopic}`);
    console.log(`   Max replies per post: ${config.maxRepliesPerPost}`);

    // Get the discussion topics for this class (auto-created by triggers)
    const { data: discussionTopics, error: topicsError } = await supabase
      .from("discussion_topics")
      .select("*")
      .eq("class_id", class_id)
      .order("ordinal");

    if (topicsError) {
      console.error("Error fetching discussion topics:", topicsError);
      throw topicsError;
    }

    if (!discussionTopics || discussionTopics.length === 0) {
      console.log("No discussion topics found - they should be auto-created by triggers");
      return;
    }

    console.log(
      `Found ${discussionTopics.length} discussion topics: ${discussionTopics.map((t) => t.topic).join(", ")}`
    );

    // All users who can post (students, instructors, graders)
    const allUsers = [...students, ...instructors, ...graders];

    // Question subjects for different topics
    const topicSubjects = {
      Assignments: [
        "Homework 1 clarification needed",
        "Project submission format?",
        "Due date extension request",
        "Grading rubric question",
        "Partner work allowed?",
        "Late submission policy",
        "Assignment requirements unclear",
        "Help with problem 3",
        "Resubmission allowed?",
        "Group work guidelines"
      ],
      Logistics: [
        "Office hours schedule",
        "Exam dates confirmed?",
        "Class cancelled today?",
        "Final exam format",
        "Missing lecture notes",
        "Room change notification",
        "Midterm review session",
        "Course syllabus update",
        "Grade distribution",
        "Contact TA question"
      ],
      Readings: [
        "Chapter 5 discussion",
        "Required vs optional readings",
        "Paper analysis help",
        "Research methodology question",
        "Citation format clarification",
        "Additional resources?",
        "Textbook alternatives",
        "Reading comprehension check",
        "Key concepts summary",
        "Follow-up questions"
      ],
      Memes: [
        "When you finally understand recursion",
        "Debugging at 3am be like...",
        "That feeling when code compiles",
        "Coffee addiction level: programmer",
        "Stack overflow saves the day again",
        "When the semester starts vs ends",
        "Professor vs student expectations",
        "Group project dynamics",
        "Finals week survival guide",
        "Coding bootcamp vs reality"
      ]
    };

    // Bodies for different types of posts
    const questionBodies = [
      "Can someone help me understand this concept? I've been struggling with it for hours.",
      "I'm not sure I understand the requirements correctly. Could someone clarify?",
      "Has anyone else encountered this issue? Looking for advice.",
      "What's the best approach for solving this type of problem?",
      "Can someone point me to relevant resources on this topic?",
      "I'm getting confused by the instructions. Any help would be appreciated.",
      "Quick question about the implementation details...",
      "Not sure if my understanding is correct. Can someone verify?",
      "Looking for study group partners for this topic.",
      "What are the common pitfalls to avoid here?"
    ];

    const replyBodies = [
      "Thanks for asking this! I had the same question.",
      "Great point! I hadn't considered that perspective.",
      "Here's what worked for me in a similar situation...",
      "I think the key is to focus on the fundamentals first.",
      "Actually, I believe there might be another way to approach this.",
      "This helped clarify things for me too!",
      "Good catch - that's an important detail to remember.",
      "I found this resource helpful: [example link]",
      "Building on what others have said...",
      "That makes perfect sense now, thank you!",
      "I had a similar issue and solved it by...",
      "Totally agree with the previous responses.",
      "Just to add to this discussion...",
      "This is exactly what I needed to know!",
      "Another thing to consider is..."
    ];

    // Track created threads for replies
    const createdThreads: Array<{ id: number; topic_id: number; is_question: boolean }> = [];

    // Collect all root threads to insert in batches
    const threadsToInsert: Array<{
      author: string;
      subject: string;
      body: string;
      class_id: number;
      topic_id: number;
      is_question: boolean;
      instructors_only: boolean;
      draft: boolean;
      root_class_id: number;
    }> = [];

    const threadMetadata: Array<{ topic_id: number; is_question: boolean }> = [];

    // Prepare all root posts for each topic
    for (const topic of discussionTopics) {
      const subjectsForTopic = topicSubjects[topic.topic as keyof typeof topicSubjects] || ["General discussion"];

      for (let i = 0; i < config.postsPerTopic; i++) {
        const user = faker.helpers.arrayElement(allUsers);
        const isAnonymous = faker.datatype.boolean(0.3); // 30% chance of anonymous posting
        const isQuestion = faker.datatype.boolean(0.6); // 60% chance of being a question
        const authorId = isAnonymous ? user.public_profile_id : user.private_profile_id;

        const subject = faker.helpers.arrayElement(subjectsForTopic);
        const body = isQuestion
          ? faker.helpers.arrayElement(questionBodies)
          : faker.lorem.paragraphs(faker.number.int({ min: 2, max: 10 }));

        threadsToInsert.push({
          author: authorId,
          subject,
          body,
          class_id,
          topic_id: topic.id,
          is_question: isQuestion,
          instructors_only: false,
          draft: false,
          root_class_id: class_id // Set for root threads
        });

        threadMetadata.push({
          topic_id: topic.id,
          is_question: isQuestion
        });
      }
    }

    // Insert threads in batches (in parallel)
    const threadBatchSize = this.rateLimitManager.batchSizes.discussion_threads;
    const totalBatches = Math.ceil(threadsToInsert.length / threadBatchSize);
    console.log(
      `Inserting ${threadsToInsert.length} root discussion threads in ${totalBatches} parallel batches of ${threadBatchSize}...`
    );

    // Create all batch operations as promises
    const batchPromises: Promise<{
      threads: Array<{ id: number }> | null;
      metadata: Array<{ topic_id: number; is_question: boolean }>;
      batchNumber: number;
    }>[] = [];

    for (let i = 0; i < threadsToInsert.length; i += threadBatchSize) {
      const batch = threadsToInsert.slice(i, i + threadBatchSize);
      const metadataBatch = threadMetadata.slice(i, i + threadBatchSize);
      const batchNumber = Math.floor(i / threadBatchSize) + 1;

      console.log(`   Preparing batch ${batchNumber}/${totalBatches}: ${batch.length} threads`);

      const batchPromise = this.rateLimitManager
        .trackAndLimit(
          "discussion_threads",
          () => supabase.from("discussion_threads").insert(batch).select("id"),
          batch.length
        )
        .then(({ data: threads, error: threadError }) => {
          if (threadError) {
            console.error(`Error creating discussion thread batch ${batchNumber}:`, threadError);
            throw new Error(`Failed to create discussion thread batch ${batchNumber}: ${threadError.message}`);
          }
          return { threads, metadata: metadataBatch, batchNumber };
        });

      batchPromises.push(batchPromise);
    }

    // Execute all batches in parallel and collect results
    console.log(`Executing ${batchPromises.length} batches in parallel...`);
    const batchResults = await Promise.all(batchPromises);

    // Process results in order to maintain consistent thread ordering
    batchResults
      .sort((a, b) => a.batchNumber - b.batchNumber)
      .forEach(({ threads, metadata }) => {
        if (threads) {
          threads.forEach((thread, index) => {
            createdThreads.push({
              id: thread.id,
              topic_id: metadata[index].topic_id,
              is_question: metadata[index].is_question
            });
          });
        }
      });

    console.log(`✓ Created ${createdThreads.length} root discussion threads`);

    // Create replies to the root posts in batches
    const repliesToInsert: Array<{
      author: string;
      subject: string;
      body: string;
      class_id: number;
      topic_id: number;
      parent: number;
      root: number;
      is_question: boolean;
      instructors_only: boolean;
      draft: boolean;
    }> = [];
    const potentialAnswers: Array<{ rootThreadId: number; replyIndex: number }> = [];

    // First, collect all replies that need to be inserted
    for (const rootThread of createdThreads) {
      const numReplies = faker.number.int({ min: 1, max: config.maxRepliesPerPost });

      for (let i = 0; i < numReplies; i++) {
        const user = faker.helpers.arrayElement(allUsers);
        const isAnonymous = faker.datatype.boolean(0.25); // 25% chance of anonymous replies
        const authorId = isAnonymous ? user.public_profile_id : user.private_profile_id;

        const body = faker.helpers.arrayElement(replyBodies);

        repliesToInsert.push({
          author: authorId,
          subject: "Re: Discussion Reply",
          body,
          class_id,
          topic_id: rootThread.topic_id,
          parent: rootThread.id,
          root: rootThread.id,
          is_question: false, // Replies are typically not questions
          instructors_only: false,
          draft: false
          // root_class_id stays null for non-root threads
        });

        // Track which replies could potentially become answers (30% chance for questions)
        if (rootThread.is_question && faker.datatype.boolean(0.3)) {
          potentialAnswers.push({
            rootThreadId: rootThread.id,
            replyIndex: repliesToInsert.length - 1 // Index of the reply we just added
          });
        }
      }
    }

    // Insert replies in batches (in parallel)
    const insertedReplies: Array<{ id: number }> = [];
    const replyBatchSize = this.rateLimitManager.batchSizes.discussion_threads;
    const totalReplyBatches = Math.ceil(repliesToInsert.length / replyBatchSize);
    console.log(
      `Inserting ${repliesToInsert.length} replies in ${totalReplyBatches} parallel batches of ${replyBatchSize}...`
    );

    // Create all batch operations as promises
    const replyBatchPromises: Promise<{ replies: Array<{ id: number }> | null; batchNumber: number }>[] = [];

    for (let i = 0; i < repliesToInsert.length; i += replyBatchSize) {
      const batch = repliesToInsert.slice(i, i + replyBatchSize);
      const batchNumber = Math.floor(i / replyBatchSize) + 1;

      const batchPromise = this.rateLimitManager
        .trackAndLimit(
          "discussion_threads",
          () => supabase.from("discussion_threads").insert(batch).select("id"),
          batch.length
        )
        .then(({ data: batchReplies, error: batchError }) => {
          if (batchError) {
            console.error(`Error inserting batch ${batchNumber}/${totalReplyBatches}:`, batchError);
            throw new Error(`Failed to insert batch ${batchNumber}: ${batchError.message}`);
          }
          return { replies: batchReplies, batchNumber };
        });

      replyBatchPromises.push(batchPromise);
    }

    // Execute all batches in parallel and collect results
    console.log(`Executing ${replyBatchPromises.length} reply batches in parallel...`);
    const replyBatchResults = await Promise.all(replyBatchPromises);

    // Process results in order to maintain consistent reply ordering
    replyBatchResults
      .sort((a, b) => a.batchNumber - b.batchNumber)
      .forEach(({ replies }) => {
        if (replies) {
          insertedReplies.push(...replies);
        }
      });

    // Mark some replies as answers for question threads
    for (const { rootThreadId, replyIndex } of potentialAnswers) {
      if (replyIndex < insertedReplies.length) {
        const replyId = insertedReplies[replyIndex].id;
        await supabase.from("discussion_threads").update({ answer: replyId }).eq("id", rootThreadId);
      }
    }

    const totalReplies = insertedReplies.length;

    console.log(`✓ Created ${totalReplies} replies to discussion threads`);
    console.log(`✓ Discussion threads seeding completed`);
  }

  private async createAssignments(
    config: SeedingConfiguration,
    class_id: number,
    students: TestingUser[]
  ): Promise<
    Array<{
      id: number;
      title: string;
      due_date: string;
      groups?: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
    }>
  > {
    console.log("\n📚 Creating assignments...");

    const assignments: Array<{
      id: number;
      title: string;
      due_date: string;
      groups?: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
    }> = [];

    // Calculate time distribution
    const timeRange = config.lastAssignmentDate.getTime() - config.firstAssignmentDate.getTime();
    const timeStep = timeRange / (config.numAssignments - 1);

    // Calculate group size for group assignments
    const groupSize = calculateGroupSize(students.length);

    // Track assignment indices
    let labAssignmentIdx = 1;
    let assignmentIdx = 1;
    let labsCreated = 0;
    let regularAssignmentsCreated = 0;

    console.log(
      `   Creating ${config.numAssignments} assignments over ${Math.ceil(timeRange / (1000 * 60 * 60 * 24))} days`
    );
    console.log(`   Lab assignments: ${config.labAssignmentConfig!.numLabAssignments}`);
    console.log(`   Group assignments: ${config.groupAssignmentConfig!.numGroupAssignments}`);
    console.log(`   Lab group assignments: ${config.groupAssignmentConfig!.numLabGroupAssignments}`);

    for (let i = 0; i < config.numAssignments; i++) {
      const assignmentDate = new Date(config.firstAssignmentDate.getTime() + timeStep * i);

      // Determine assignment type
      const shouldCreateLab = i % 2 === 0;
      const canCreateLab = labsCreated < config.labAssignmentConfig!.numLabAssignments;
      const canCreateRegularAssignment =
        regularAssignmentsCreated < config.numAssignments - config.labAssignmentConfig!.numLabAssignments;

      let isLabAssignment: boolean;
      if (shouldCreateLab && canCreateLab) {
        isLabAssignment = true;
        labsCreated++;
      } else if (!shouldCreateLab && canCreateRegularAssignment) {
        isLabAssignment = false;
        regularAssignmentsCreated++;
      } else if (canCreateLab) {
        isLabAssignment = true;
        labsCreated++;
      } else {
        isLabAssignment = false;
        regularAssignmentsCreated++;
      }

      const isGroupAssignment = i < config.groupAssignmentConfig!.numGroupAssignments;
      const isLabGroupAssignment = isLabAssignment && i < config.groupAssignmentConfig!.numLabGroupAssignments;

      // Determine group configuration
      let groupConfig: "individual" | "groups" | "both" = "individual";
      if (isGroupAssignment || isLabGroupAssignment) {
        groupConfig = "groups";
      }

      const name = isLabAssignment ? `Lab ${labAssignmentIdx}` : `Assignment ${assignmentIdx}`;
      if (isLabAssignment) {
        labAssignmentIdx++;
      } else {
        assignmentIdx++;
      }

      // Create self review setting first
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

      const title = name + (groupConfig !== "individual" ? " (Group)" : "");
      const ourAssignmentIdx = isLabAssignment ? labAssignmentIdx - 1 : assignmentIdx - 1;

      // Create assignment
      const { data: insertedAssignmentData, error: assignmentError } = await this.rateLimitManager.trackAndLimit(
        "assignments",
        () =>
          supabase
            .from("assignments")
            .insert({
              title: title,
              description: "This is an enhanced test assignment with diverse rubric structure",
              due_date: assignmentDate.toISOString(),
              minutes_due_after_lab: isLabAssignment ? config.labAssignmentConfig!.minutesDueAfterLab : undefined,
              template_repo: TEST_HANDOUT_REPO,
              autograder_points: 20,
              total_points: 100,
              max_late_tokens: 10,
              release_date: addDays(new Date(), -1).toISOString(),
              class_id: class_id,
              slug: isLabAssignment ? `lab-${ourAssignmentIdx}` : `assignment-${ourAssignmentIdx}`,
              group_config: groupConfig,
              allow_not_graded_submissions: false,
              self_review_setting_id: selfReviewSettingData.id,
              max_group_size: 6,
              group_formation_deadline: addDays(new Date(), -1).toISOString()
            })
            .select("id")
      );
      //If we have a LOT of students, just wait extra... gradebook columns are a lot of work!
      if (students.length > 500) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      if (assignmentError) {
        throw new Error(`Failed to create assignment: ${assignmentError.message}`);
      }

      const { data: assignmentData, error: assignmentDataError } = await supabase
        .from("assignments")
        .select("*")
        .eq("id", insertedAssignmentData[0].id)
        .single();

      if (assignmentDataError || !assignmentData) {
        throw new Error(`Failed to fetch assignment data: ${assignmentDataError?.message || "No data returned"}`);
      }

      // Update autograder config
      const { data: autograderData, error: autograderError } = await supabase
        .from("autograder")
        .update({
          grader_repo: "pawtograder-playground/test-e2e-java-solution",
          grader_commit_sha: "76ece6af6a251346596fcc71181a86599faf0fe3be0f85c532ff20c2f0939177",
          max_submissions_count: null,
          max_submissions_period_secs: null,
          config: { submissionFiles: { files: ["**/*.java", "**/*.py", "**/*.arr", "**/*.ts"], testFiles: [] } }
        })
        .eq("id", assignmentData.id)
        .single();
      if (autograderError) {
        throw new Error(`Failed to update autograder: ${autograderError.message}`);
      }
      await supabase
        .from("assignments")
        .update({
          template_repo: "pawtograder-playground/test-e2e-java-handout"
        })
        .eq("id", assignmentData.id);

      // Create rubric structure
      await this.createRubricForAssignment(assignmentData, config.rubricConfig!);

      // Create assignment groups for group assignments
      let groups: Array<{ id: number; name: string; memberCount: number; members: string[] }> = [];
      if (isGroupAssignment || isLabGroupAssignment) {
        groups = await this.createAssignmentGroups(assignmentData.id, class_id, students, groupSize);
      }

      const assignmentResult = {
        id: assignmentData.id,
        title: assignmentData.title,
        due_date: assignmentData.due_date,
        groups: groups.length > 0 ? groups : undefined
      };

      assignments.push(assignmentResult);

      console.log(`✓ Created ${title}${groups.length > 0 ? ` with ${groups.length} groups` : ""}`);
    }

    console.log(`✓ Created ${assignments.length} assignments total`);
    return assignments;
  }

  protected async createSubmissions(
    assignments: Array<{
      id: number;
      title: string;
      due_date: string;
      groups?: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
    }>,
    students: TestingUser[],
    class_id: number
  ): Promise<
    Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      repository_id?: number;
    }>
  > {
    console.log("\n📝 Creating submissions...");

    const now = new Date();
    const submissionsToCreate: Array<{
      assignment: {
        id: number;
        due_date: string;
        title: string;
        groups?: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
      };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      isRecentlyDue: boolean;
    }> = [];

    // Generate submissions for each assignment
    assignments.forEach((assignment) => {
      const isRecentlyDue = new Date(assignment.due_date) < now;

      if (assignment.groups && assignment.groups.length > 0) {
        // Group assignment - 75% chance to create a group submission
        assignment.groups.forEach((group) => {
          if (Math.random() < 0.75) {
            submissionsToCreate.push({
              assignment: { ...assignment },
              group,
              isRecentlyDue
            });
          }
        });
      } else {
        // Individual assignment - 95% chance student submitted
        students.forEach((student) => {
          if (Math.random() < 0.95) {
            submissionsToCreate.push({
              assignment: { ...assignment },
              student,
              isRecentlyDue
            });
          }
        });
      }
    });

    console.log(`   Prepared ${submissionsToCreate.length} submissions for batch creation`);

    // Batch create all submissions
    const createdSubmissions = await this.batchCreateSubmissions(submissionsToCreate, class_id);
    console.log(`✓ Created ${createdSubmissions.length} submissions`);

    return createdSubmissions;
  }

  protected async createWorkflowEvents(
    submissionData: Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      repository_id?: number;
    }>,
    class_id: number
  ) {
    console.log("\n⚡ Creating workflow events...");

    if (submissionData.length === 0) {
      console.log("   No submissions to create workflow events for");
      return;
    }

    console.log(`   Creating workflow events for ${submissionData.length} submissions`);

    const workflowEventsToCreate: Array<{
      workflow_run_id: number;
      repository_name: string;
      class_id: number;
      workflow_name: string;
      workflow_path: string;
      head_sha: string;
      head_branch: string;
      run_number: number;
      repository_id: number | null;
      run_attempt: number;
      actor_login: string;
      triggering_actor_login: string;
      pull_requests: null;
      event_type: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      started_at: string;
      updated_at: string;
      run_started_at: string;
      run_updated_at: string;
      payload: unknown;
    }> = [];

    const now = new Date();

    for (const submission of submissionData) {
      if (!submission.repository_id) {
        console.warn(`Skipping submission ${submission.submission_id} - no repository_id`);
        continue;
      }

      // Create 1-3 workflow runs per submission (representing multiple attempts)
      const numRuns = Math.floor(Math.random() * 3) + 1;

      for (let runIndex = 0; runIndex < numRuns; runIndex++) {
        const workflowRunId = 1000000 + submission.submission_id * 10 + runIndex;
        const runNumber = runIndex + 1;
        const runAttempt = 1;

        // Generate realistic repository name based on submission
        const repositoryName = `student-repo-${submission.submission_id}`;
        const headSha = `abc123${submission.submission_id.toString().padStart(6, "0")}${runIndex.toString()}ef`;
        const actorLogin = submission.student?.email.split("@")[0] || `group-${submission.group?.id}`;

        // Create realistic timing patterns
        const submissionAge =
          Math.abs(now.getTime() - new Date(submission.assignment.due_date).getTime()) / (1000 * 60 * 60 * 24); // days

        let baseQueueTime: number;
        let baseRunTime: number;

        if (submissionAge < 1) {
          // Very recent - fast processing (last 24 hours)
          baseQueueTime = 15 + Math.random() * 45; // 15-60 seconds
          baseRunTime = 45 + Math.random() * 75; // 45-120 seconds
        } else if (submissionAge < 7) {
          // Recent week - moderate processing
          baseQueueTime = 30 + Math.random() * 120; // 30-150 seconds
          baseRunTime = 60 + Math.random() * 120; // 60-180 seconds
        } else if (submissionAge < 30) {
          // Last month - varied processing
          baseQueueTime = 60 + Math.random() * 300; // 1-6 minutes
          baseRunTime = 90 + Math.random() * 210; // 90-300 seconds
        } else {
          // Older - potentially slower processing
          baseQueueTime = 120 + Math.random() * 600; // 2-12 minutes
          baseRunTime = 120 + Math.random() * 480; // 2-10 minutes
        }

        // Add some variance for retry attempts
        if (runIndex > 0) {
          baseQueueTime *= 1 + runIndex * 0.3; // Subsequent runs take longer to queue
          baseRunTime *= 0.8 + Math.random() * 0.4; // But might run faster/slower
        }

        const queueTimeSeconds = Math.round(baseQueueTime);
        const runTimeSeconds = Math.round(baseRunTime);

        // Calculate realistic timestamps
        const dueDate = new Date(submission.assignment.due_date);
        const submissionTime = new Date(dueDate.getTime() - Math.random() * 24 * 60 * 60 * 1000); // Up to 24h before due
        const requestedAt = new Date(submissionTime.getTime() + runIndex * 10 * 60 * 1000); // 10 minutes between attempts
        const inProgressAt = new Date(requestedAt.getTime() + queueTimeSeconds * 1000);
        const completedAt = new Date(inProgressAt.getTime() + runTimeSeconds * 1000);

        // Determine final outcome based on patterns
        const isCompleted = Math.random() < 0.95; // 95% completion rate
        const isSuccess = isCompleted && Math.random() < 0.85; // 85% success rate when completed

        // Create base workflow event data
        const baseWorkflowEvent = {
          workflow_run_id: workflowRunId,
          repository_name: repositoryName,
          class_id: class_id,
          workflow_name: "Grade Assignment",
          workflow_path: ".github/workflows/grade.yml",
          head_sha: headSha,
          head_branch: "main",
          run_number: runNumber,
          repository_id: submission.repository_id,
          run_attempt: runAttempt,
          actor_login: actorLogin,
          triggering_actor_login: actorLogin,
          pull_requests: null
        };

        // ALWAYS create events in chronological order: queued → in_progress → completed (if completed)

        // 1. QUEUED/REQUESTED event
        workflowEventsToCreate.push({
          ...baseWorkflowEvent,
          event_type: "requested",
          status: "queued",
          conclusion: null,
          created_at: requestedAt.toISOString(),
          started_at: requestedAt.toISOString(),
          updated_at: requestedAt.toISOString(),
          run_started_at: requestedAt.toISOString(),
          run_updated_at: requestedAt.toISOString(),
          payload: {
            action: "requested",
            workflow_run: {
              id: workflowRunId,
              status: "queued",
              conclusion: null
            }
          }
        });

        // 2. IN_PROGRESS event
        workflowEventsToCreate.push({
          ...baseWorkflowEvent,
          event_type: "in_progress",
          status: "in_progress",
          conclusion: null,
          created_at: requestedAt.toISOString(),
          started_at: inProgressAt.toISOString(),
          updated_at: inProgressAt.toISOString(),
          run_started_at: inProgressAt.toISOString(),
          run_updated_at: inProgressAt.toISOString(),
          payload: {
            action: "in_progress",
            workflow_run: {
              id: workflowRunId,
              status: "in_progress",
              conclusion: null
            }
          }
        });

        // 3. COMPLETED event (if the workflow completed)
        if (isCompleted) {
          const finalConclusion = isSuccess ? "success" : "failure";
          workflowEventsToCreate.push({
            ...baseWorkflowEvent,
            event_type: "completed",
            status: "completed",
            conclusion: finalConclusion,
            created_at: requestedAt.toISOString(),
            started_at: inProgressAt.toISOString(),
            updated_at: completedAt.toISOString(),
            run_started_at: inProgressAt.toISOString(),
            run_updated_at: completedAt.toISOString(),
            payload: {
              action: "completed",
              workflow_run: {
                id: workflowRunId,
                status: "completed",
                conclusion: finalConclusion
              }
            }
          });
        }
      }
    }

    // Batch insert workflow events
    if (workflowEventsToCreate.length > 0) {
      const BATCH_SIZE = this.rateLimits["workflow_events"].batchSize || 1;
      const chunks = chunkArray(workflowEventsToCreate, BATCH_SIZE);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await this.rateLimitManager.trackAndLimit(
          "workflow_events",
          () =>
            supabase
              .from("workflow_events")
              .insert(chunk as unknown as Database["public"]["Tables"]["workflow_events"]["Insert"][])
              .select("id"),
          chunk.length
        );

        console.log(`   ✓ Created batch ${i + 1}/${chunks.length} (${chunk.length} events)`);
      }

      console.log(`   ✓ Created ${workflowEventsToCreate.length} workflow events total`);

      // Log statistics
      const completedEvents = workflowEventsToCreate.filter((e) => e.status === "completed");
      const successRate =
        completedEvents.length > 0
          ? completedEvents.filter((e) => e.conclusion === "success").length / completedEvents.length
          : 0;

      console.log(`   Statistics: ${completedEvents.length} completed, success: ${Math.round(successRate * 100)}%`);
    }
  }

  protected async createWorkflowErrors(
    submissionData: Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      repository_id?: number;
    }>,
    class_id: number
  ) {
    console.log("\n🚨 Creating workflow errors...");

    // Select 20% of submissions to have errors
    const submissionsWithErrors = submissionData
      .filter(() => Math.random() < 0.2)
      .slice(0, Math.floor(submissionData.length * 0.2));

    if (submissionsWithErrors.length === 0) {
      console.log("   No submissions selected for workflow errors");
      return;
    }

    console.log(`   Creating errors for ${submissionsWithErrors.length} submissions (20% of ${submissionData.length})`);

    // Define clever and deterministic error messages
    const userVisibleErrors = [
      "Submission is late by 2 hours - late penalty applied",
      "Missing required file: README.md - please add documentation",
      "File size exceeds limit: main.java is 15MB, max allowed is 10MB",
      "Invalid file format: .docx files not allowed, use .txt or .md",
      "Compilation failed: syntax error on line 42 in Calculator.java",
      "Missing dependencies: package.json not found in submission",
      "Test timeout: unit tests took longer than 30 seconds to complete",
      "Memory limit exceeded: program used 2GB, limit is 1GB",
      "Duplicate submission detected: previous submission at 14:32 will be used",
      "Branch mismatch: submitted from 'develop' branch, expected 'main'",
      "Commit message too short: minimum 10 characters required",
      "Binary files detected: .exe files are not allowed in submissions",
      "Plagiarism check failed: 85% similarity with another submission",
      "Missing unit tests: no test files found in src/test/ directory",
      "Code quality issue: cyclomatic complexity exceeds threshold",
      "Forbidden keyword usage: 'System.exit()' not allowed in submissions",
      "File encoding error: non-UTF-8 characters detected in source code",
      "Missing required method: 'main()' method not found in entry class",
      "Import restrictions violated: java.io.File package not permitted",
      "Submission format error: expected .zip file, received .rar"
    ];

    const securityErrors = [
      "Security scan failed: potential SQL injection vulnerability detected",
      "Unsafe file operations: direct file system access not permitted",
      "Network access violation: HTTP requests blocked in sandbox environment",
      "Privilege escalation attempt: sudo commands detected in script",
      "Malicious pattern found: base64 encoded payload in comments",
      "Cryptographic weakness: hardcoded encryption keys discovered",
      "Path traversal vulnerability: '../' sequences found in file operations",
      "Command injection risk: user input directly passed to shell",
      "Buffer overflow potential: unsafe string operations detected",
      "Cross-site scripting vector: unescaped user data in HTML output",
      "Deserialization vulnerability: unsafe object deserialization found",
      "Information disclosure: database credentials exposed in code",
      "Insecure random generation: predictable seed values used",
      "Authentication bypass: hardcoded admin credentials detected",
      "Race condition vulnerability: unsynchronized shared resource access"
    ];

    const instructorConfigErrors = [
      "Instructor action required: update autograder timeout to 45 seconds",
      "Configuration mismatch: expected Java 11, but runner uses Java 8",
      "Grading rubric incomplete: missing criteria for code style section",
      "Test suite outdated: unit tests need update for new requirements",
      "Resource allocation error: increase memory limit to 2GB for this assignment",
      "Docker image misconfigured: missing required build tools in container",
      "Assignment template error: starter code has compilation errors",
      "Deadline configuration issue: due date conflicts with university holiday",
      "GitHub webhook failure: repository permissions need instructor review",
      "Plagiarism detector offline: manual review required for submissions",
      "Grade export blocked: Canvas integration credentials expired",
      "Autograder script error: contact TA to fix grading pipeline issue",
      "Class repository locked: instructor needs to update access permissions",
      "Feedback template missing: add comment templates for common issues",
      "Extension policy undefined: set clear rules for late submission handling"
    ];

    // Create workflow errors using repository_id reference
    const workflowErrorsToCreate: {
      submission_id: number;
      class_id: number;
      repository_id: number;
      name: string;
      run_number: number;
      run_attempt: number;
      data: { type: string };
      is_private: boolean;
      created_at: string;
    }[] = [];

    for (const submission of submissionsWithErrors) {
      // Skip submissions without repository_id
      if (!submission.repository_id) {
        console.warn(`Skipping submission ${submission.submission_id} - no repository_id`);
        continue;
      }

      const runAttempt = 1;
      const runNumber = Math.floor(Math.random() * 100) + 1;

      // Generate 1-5 errors per submission
      const numErrors = Math.floor(Math.random() * 5) + 1;

      for (let i = 0; i < numErrors; i++) {
        // Use submission ID and error index to deterministically select error type
        const errorTypeIndex = (submission.submission_id + i) % 3;
        let errorMessage: string;
        let isPrivate: boolean;
        let errorType: string;

        if (errorTypeIndex === 0) {
          // User visible error
          const messageIndex = (submission.submission_id + i) % userVisibleErrors.length;
          errorMessage = userVisibleErrors[messageIndex];
          isPrivate = Math.random() < 0.3; // 30% chance to be private
          errorType = "user_visible_error";
        } else if (errorTypeIndex === 1) {
          // Security error (always private)
          const messageIndex = (submission.submission_id + i) % securityErrors.length;
          errorMessage = securityErrors[messageIndex];
          isPrivate = true;
          errorType = "security_error";
        } else {
          // Instructor config error
          const messageIndex = (submission.submission_id + i) % instructorConfigErrors.length;
          errorMessage = instructorConfigErrors[messageIndex];
          isPrivate = Math.random() < 0.5; // 50% chance to be private
          errorType = "config_error";
        }

        workflowErrorsToCreate.push({
          submission_id: submission.submission_id,
          class_id: class_id,
          repository_id: submission.repository_id,
          run_number: runNumber,
          run_attempt: runAttempt,
          name: errorMessage,
          data: { type: errorType },
          is_private: isPrivate,
          created_at: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString()
        });
      }
    }

    // Batch insert workflow errors
    if (workflowErrorsToCreate.length > 0) {
      const BATCH_SIZE = this.rateLimits["workflow_run_error"].batchSize || 100;
      const chunks = chunkArray(workflowErrorsToCreate, BATCH_SIZE);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const { error: workflowErrorsError } = await this.rateLimitManager.trackAndLimit(
          "workflow_run_error",
          () => supabase.from("workflow_run_error").insert(chunk).select("id"),
          chunk.length
        );

        if (workflowErrorsError) {
          throw new Error(`Failed to create workflow errors: ${workflowErrorsError.message}`);
        }
      }

      console.log(`   ✓ Created ${workflowErrorsToCreate.length} workflow errors`);

      // Log breakdown by type
      const userVisibleCount = workflowErrorsToCreate.filter((e) => e.data.type === "user_visible_error").length;
      const securityCount = workflowErrorsToCreate.filter((e) => e.data.type === "security_error").length;
      const configCount = workflowErrorsToCreate.filter((e) => e.data.type === "config_error").length;
      const privateCount = workflowErrorsToCreate.filter((e) => e.is_private).length;

      console.log(
        `   Error breakdown: ${userVisibleCount} user-visible, ${securityCount} security, ${configCount} config`
      );
      console.log(
        `   Privacy breakdown: ${privateCount} private, ${workflowErrorsToCreate.length - privateCount} public`
      );
    }
  }

  /**
   * Helper function to batch queries to submissions table to avoid query length limits
   */
  private async batchQuerySubmissions(
    submissionIds: number[],
    batchSize: number = 100
  ): Promise<Array<{ id: number; grading_review_id: number | null }>> {
    if (submissionIds.length === 0) return [];

    const results: Array<{ id: number; grading_review_id: number | null }> = [];

    // Process IDs in batches
    for (let i = 0; i < submissionIds.length; i += batchSize) {
      const batch = submissionIds.slice(i, i + batchSize);

      const { data, error } = await supabase.from("submissions").select("id, grading_review_id").in("id", batch);

      if (error) {
        throw new Error(`Failed to query submissions: ${error.message}`);
      }

      if (data) {
        results.push(...data);
      }
    }

    return results;
  }

  /**
   * Helper function to batch queries to submission_reviews table to avoid query length limits
   */
  private async batchQuerySubmissionReviews(
    reviewIds: number[],
    batchSize: number = 100
  ): Promise<Array<{ id: number; submission_id: number; rubric_id: number; class_id: number }>> {
    if (reviewIds.length === 0) return [];

    const results: Array<{ id: number; submission_id: number; rubric_id: number; class_id: number }> = [];

    // Process IDs in batches
    for (let i = 0; i < reviewIds.length; i += batchSize) {
      const batch = reviewIds.slice(i, i + batchSize);

      const { data, error } = await supabase
        .from("submission_reviews")
        .select("id, submission_id, rubric_id, class_id")
        .in("id", batch);

      if (error) {
        throw new Error(`Failed to query submission_reviews: ${error.message}`);
      }

      if (data) {
        results.push(...data);
      }
    }

    return results;
  }

  protected async gradeSubmissions(
    submissionData: Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      repository_id?: number;
    }>,
    graders: TestingUser[],
    _students: TestingUser[]
  ) {
    console.log("\n📊 Grading submissions...");

    if (submissionData.length === 0) return;

    // Get all submission review IDs (batched to avoid query length limits)
    const submissionIds = submissionData.map((s) => s.submission_id);
    const submissionReviews = await this.batchQuerySubmissions(submissionIds);

    const reviewsToProcess = submissionReviews?.filter((s) => s.grading_review_id) || [];
    if (reviewsToProcess.length === 0) return;

    // Get all submission review details (batched to avoid query length limits)
    const reviewIds = reviewsToProcess.map((s) => s.grading_review_id).filter((id): id is number => id !== null);
    const reviewInfo = await this.batchQuerySubmissionReviews(reviewIds);

    // Group reviews by rubric_id to batch fetch rubric checks
    const reviewsByRubric = new Map<
      number,
      Array<{ id: number; submission_id: number; rubric_id: number; class_id: number }>
    >();
    reviewInfo?.forEach((review) => {
      if (!reviewsByRubric.has(review.rubric_id)) {
        reviewsByRubric.set(review.rubric_id, []);
      }
      reviewsByRubric.get(review.rubric_id)!.push(review);
    });

    // Get all rubric checks for all rubrics in parallel
    const rubricCheckQueries = Array.from(reviewsByRubric.keys()).map((rubricId) =>
      supabase
        .from("rubric_checks")
        .select(
          `
          id, name, is_annotation, points, is_required, file,
          rubric_criteria!inner(id, rubric_id)
        `
        )
        .eq("rubric_criteria.rubric_id", rubricId)
    );

    const rubricCheckResults = await Promise.all(rubricCheckQueries);
    const rubricChecksMap = new Map<
      number,
      Array<{
        id: number;
        name: string;
        is_annotation: boolean;
        points: number;
        is_required: boolean;
        file?: string | null;
      }>
    >();

    rubricCheckResults.forEach((result, index) => {
      const rubricId = Array.from(reviewsByRubric.keys())[index];
      if (result.data) {
        rubricChecksMap.set(rubricId, result.data);
      }
    });

    // Get all submission files for annotations
    const { data: submissionFiles } = await supabase
      .from("submission_files")
      .select("id, name, submission_id")
      .in("submission_id", submissionIds);

    const submissionFilesMap = new Map<number, Array<{ id: number; name: string; submission_id: number }>>();
    submissionFiles?.forEach((file) => {
      if (!submissionFilesMap.has(file.submission_id)) {
        submissionFilesMap.set(file.submission_id, []);
      }
      submissionFilesMap.get(file.submission_id)!.push(file);
    });

    // Prepare all grading data
    const submissionComments: Array<{
      submission_id: number;
      author: string;
      comment: string;
      points: number;
      class_id: number;
      released: boolean;
      rubric_check_id: number;
      submission_review_id: number;
    }> = [];
    const submissionFileComments: Array<{
      submission_id: number;
      submission_file_id: number;
      author: string;
      comment: string;
      points: number;
      line: number;
      class_id: number;
      released: boolean;
      rubric_check_id: number;
      submission_review_id: number;
    }> = [];
    const reviewUpdates = new Map<
      number,
      {
        grader: string;
        released: boolean;
        completed_by: string | null;
        completed_at: string | null;
      }
    >();

    for (const review of reviewInfo || []) {
      const isCompleted = Math.random() < 0.95; // 95% chance review is completed
      const grader = graders[Math.floor(Math.random() * graders.length)];
      const rubricChecks = rubricChecksMap.get(review.rubric_id) || [];
      const files = submissionFilesMap.get(review.submission_id) || [];

      if (isCompleted) {
        // Calculate maximum possible points for this rubric
        const targetTotalPoints = 90; //Math.floor(maxPossiblePoints * targetPercentage);

        // Filter checks that will be applied
        const applicableChecks = rubricChecks.filter((check) => {
          const applyChance = 0.8;
          return check.is_required || Math.random() < applyChance;
        });

        // Distribute target points among applicable checks (ignore individual check.points limits)
        const checkPointAllocations = new Map<number, number>();

        // Distribute points roughly equally among checks with some randomness
        let remainingPoints = targetTotalPoints;

        for (let i = 0; i < applicableChecks.length; i++) {
          const check = applicableChecks[i];

          if (i === applicableChecks.length - 1) {
            // Last check gets all remaining points
            checkPointAllocations.set(check.id, remainingPoints);
            remainingPoints = 0;
          } else {
            // Allocate roughly equal portion with some randomness
            const baseAllocation = Math.floor(targetTotalPoints / applicableChecks.length);
            const randomBonus = Math.floor(Math.random() * 10) - 5; // ±5 points variance
            const allocation = Math.max(1, baseAllocation + randomBonus); // At least 1 point

            // Don't allocate more than what's remaining
            const finalAllocation = Math.min(allocation, remainingPoints - (applicableChecks.length - i - 1));

            checkPointAllocations.set(check.id, finalAllocation);
            remainingPoints -= finalAllocation;
          }
        }

        const totalPointsAwarded = Array.from(checkPointAllocations.values()).reduce((sum, points) => sum + points, 0);
        if (totalPointsAwarded !== targetTotalPoints) {
          console.log(`Total points awarded: ${totalPointsAwarded} !== target total points: ${targetTotalPoints}`);
        }
        // Create comments for applicable checks with allocated points
        for (const check of applicableChecks) {
          const pointsAwarded = checkPointAllocations.get(check.id) || 0;

          if (check.is_annotation && files.length > 0) {
            // Create submission file comment (annotation)
            const file = files[Math.floor(Math.random() * files.length)];
            const lineNumber = Math.floor(Math.random() * 5) + 1;

            submissionFileComments.push({
              submission_id: review.submission_id,
              submission_file_id: file.id,
              author: grader.private_profile_id,
              comment: `${check.name}: Grading comment for this check`,
              points: pointsAwarded,
              line: lineNumber,
              class_id: review.class_id,
              released: true,
              rubric_check_id: check.id,
              submission_review_id: review.id
            });
          } else {
            // Create submission comment (general comment)
            submissionComments.push({
              submission_id: review.submission_id,
              author: grader.private_profile_id,
              comment: `${check.name}: ${pointsAwarded}/${check.points} points - ${check.name.includes("quality") ? "Good work on this aspect!" : "Applied this grading criteria"}`,
              points: pointsAwarded,
              class_id: review.class_id,
              released: true,
              rubric_check_id: check.id,
              submission_review_id: review.id
            });
          }
        }
      }

      reviewUpdates.set(review.id, {
        grader: grader.private_profile_id,
        released: isCompleted,
        completed_by: isCompleted ? grader.private_profile_id : null,
        completed_at: isCompleted ? new Date().toISOString() : null
      });
    }

    // Batch insert comments sequentially in chunks of 50
    const COMMENT_BATCH_SIZE = this.rateLimits["submission_comments"].batchSize || 1;

    console.log(`   Preparing submission comments batch ${submissionComments.length} comments`);
    if (submissionComments.length > 0) {
      const commentChunks = chunkArray(submissionComments, COMMENT_BATCH_SIZE);

      for (let index = 0; index < commentChunks.length; index++) {
        const chunk = commentChunks[index];
        const { error: commentsError } = await this.rateLimitManager.trackAndLimit(
          "submission_comments",
          () => supabase.from("submission_comments").insert(chunk).select("id"),
          chunk.length
        );

        if (commentsError) {
          throw new Error(`Failed to batch create submission comments (batch ${index + 1}): ${commentsError.message}`);
        }
      }
    }

    console.log(`   Preparing submission file comments batch ${submissionFileComments.length} comments`);
    if (submissionFileComments.length > 0) {
      const batchSize = this.rateLimits["submission_file_comments"].batchSize || 50;
      const fileCommentChunks = chunkArray(submissionFileComments, batchSize);

      for (let index = 0; index < fileCommentChunks.length; index++) {
        const chunk = fileCommentChunks[index];
        const { error: fileCommentsError } = await this.rateLimitManager.trackAndLimit(
          "submission_file_comments",
          () => supabase.from("submission_file_comments").insert(chunk).select("id"),
          chunk.length
        );

        if (fileCommentsError) {
          throw new Error(
            `Failed to batch create submission file comments (batch ${index + 1}): ${fileCommentsError.message}`
          );
        }
      }
    }

    // Batch update reviews in parallel chunks (Supabase doesn't support bulk updates)
    const UPDATE_BATCH_SIZE = 5; // Smaller batch size for concurrent operations
    const reviewUpdateEntries = Array.from(reviewUpdates.entries());
    const updateChunks = chunkArray(reviewUpdateEntries, UPDATE_BATCH_SIZE);

    await Promise.all(
      updateChunks.map(async (chunk, chunkIndex) => {
        const updatePromises = chunk.map(([reviewId, updateData]) =>
          this.rateLimitManager.trackAndLimit("submission_reviews", () =>
            supabase.from("submission_reviews").update(updateData).eq("id", reviewId).select("id")
          )
        );

        const updateResults = await Promise.all(updatePromises);
        const updateErrors = updateResults.filter((result) => result.error);

        if (updateErrors.length > 0) {
          console.error(
            "Update errors:",
            updateErrors.map((e) => ({ error: e.error, data: e.data }))
          );
          console.error("Sample update data:", chunk[0][1]);
          throw new Error(
            `Failed to update ${updateErrors.length} submission reviews in batch ${chunkIndex + 1}: ${updateErrors[0].error?.message}`
          );
        }
      })
    );

    console.log(`✓ Processed grading for ${reviewsToProcess.length} submissions`);
    console.log(`   Created ${submissionComments.length} submission comments`);
    console.log(`   Created ${submissionFileComments.length} submission file comments`);
    return submissionComments;
  }

  protected async createExtensionsAndRegradeRequests(
    submissionData: Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
    }>,
    _assignments: Array<{ id: number; title: string }>,
    graders: TestingUser[],
    class_id: number
  ) {
    console.log("\n⏰ Creating extensions and regrade requests...");

    // Pick students who will get extensions (10% of submissions)
    console.log("   Selecting submissions for extensions...");
    const submissionsForExtensions = new Set<number>();
    const numSubmissionsForExtensions = Math.floor(submissionData.length * 0.1); // 10% of submissions get extensions
    const shuffledSubmissions = [...submissionData].sort(() => Math.random() - 0.5);

    for (let i = 0; i < Math.min(numSubmissionsForExtensions, shuffledSubmissions.length); i++) {
      submissionsForExtensions.add(shuffledSubmissions[i].submission_id);
    }
    console.log(`   ✓ Selected ${submissionsForExtensions.size} submissions for extensions`);

    // Create due date exceptions (extensions) for selected submissions
    console.log("   Creating due date extensions...");

    // First, create array of all extension data to insert
    const extensionsToInsert = submissionData
      .filter(({ submission_id, student }) => student && submissionsForExtensions.has(submission_id))
      .map(({ assignment, student }) => ({
        assignment_id: assignment.id,
        student_id: student!.private_profile_id,
        class_id: class_id,
        hours: Math.floor(5000 / 60), // Convert minutes to hours
        creator_id: student!.private_profile_id,
        note: "Automatically granted extension for testing purposes"
      }));

    // Insert extensions in batches of 100
    const batchSize = this.rateLimits["assignment_due_date_exceptions"].batchSize || 100;
    for (let i = 0; i < extensionsToInsert.length; i += batchSize) {
      const batch = extensionsToInsert.slice(i, i + batchSize);

      await this.rateLimitManager.trackAndLimit("assignment_due_date_exceptions", () =>
        supabase.from("assignment_due_date_exceptions").insert(batch).select("id")
      );
    }

    console.log(`   ✓ Created ${extensionsToInsert.length} due date extensions`);

    // Create regrade requests for 20% of submissions at random
    console.log("   Creating regrade requests...");
    const statuses: Array<"opened" | "resolved" | "closed"> = ["opened", "resolved", "closed"];

    const numRegradeRequests = Math.max(Math.max(1, Math.floor(submissionData.length * 0.2)), 1000);
    // Shuffle the submissionData array and take first N items
    const shuffledSubmissionsForRegrades = submissionData
      .map((value) => ({ value, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ value }) => value)
      .slice(0, numRegradeRequests);

    // First, fetch existing comments for all submissions that we want to create regrade requests for
    const submissionIds = shuffledSubmissionsForRegrades.map(({ submission_id }) => submission_id);

    const comments = await supabase.from("submission_comments").select("*").in("submission_id", submissionIds);
    const submissionComments = comments.data || [];
    // Group comments by submission_id for easy lookup
    const commentsBySubmission = submissionComments.reduce(
      (acc, comment) => {
        if (!acc[comment.submission_id]) {
          acc[comment.submission_id] = [];
        }
        acc[comment.submission_id].push(comment);
        return acc;
      },
      {} as Record<number, Array<(typeof submissionComments)[number]>>
    );

    // Collect all regrade request data for batch insert
    const regradeRequestsData: Array<{
      submission_id: number;
      assignment_id: number;
      assignee: string;
      created_by: string;
      class_id: number;
      status: "opened" | "resolved" | "closed";
      resolved_at: string | null;
      resolved_by: string | null;
      submission_comment_id: number;
      initial_points: number | null;
      resolved_points: number | null;
      closed_points: number | null;
    }> = [];
    for (const { submission_id, assignment, student, group } of shuffledSubmissionsForRegrades) {
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      const grader = graders[Math.floor(Math.random() * graders.length)];

      if (!student && !group) {
        console.log("No student or group found for submission", submission_id);
        continue;
      }

      // Get existing comments for this submission
      const submissionComments = commentsBySubmission[submission_id];
      if (!submissionComments || submissionComments.length === 0) {
        continue;
      }

      // Randomly select one of the existing comments
      const selectedComment = submissionComments[Math.floor(Math.random() * submissionComments.length)];

      // Add regrade request data to batch
      regradeRequestsData.push({
        submission_id: submission_id,
        assignment_id: assignment.id,
        assignee: grader.private_profile_id,
        created_by: student ? student.private_profile_id : group ? group.members[0] : "",
        class_id: class_id,
        status: status,
        resolved_at: status !== "opened" ? new Date().toISOString() : null,
        resolved_by: status !== "opened" ? grader.private_profile_id : null,
        submission_comment_id: selectedComment.id, // Reference existing comment
        initial_points: selectedComment.points,
        resolved_points: status === "resolved" || status === "closed" ? Math.floor(Math.random() * 100) : null,
        closed_points: status === "closed" ? Math.floor(Math.random() * 100) : null
      });
    }

    // Perform batch insert if we have data
    if (regradeRequestsData.length > 0) {
      const BATCH_SIZE = this.rateLimits["submission_regrade_requests"].batchSize || 1;
      const regradeChunks = chunkArray(regradeRequestsData, BATCH_SIZE);

      console.log(`   Processing ${regradeRequestsData.length} regrade requests in ${regradeChunks.length} batches...`);

      for (let i = 0; i < regradeChunks.length; i++) {
        const chunk = regradeChunks[i];
        const { error: regradeError } = await this.rateLimitManager.trackAndLimit(
          "submission_regrade_requests",
          () => supabase.from("submission_regrade_requests").insert(chunk).select("id"),
          chunk.length
        );

        if (regradeError) {
          console.error(
            `Failed to insert regrade requests batch ${i + 1}/${regradeChunks.length}: ${regradeError.message}`
          );
          return;
        }
      }
    }

    console.log(`   ✓ Created ${regradeRequestsData.length} regrade requests`);

    // Log summary
    const openedCount = Math.round(regradeRequestsData.length * 0.33); // Approximate since we use random status
    const resolvedCount = Math.round(regradeRequestsData.length * 0.33);
    const closedCount = regradeRequestsData.length - openedCount - resolvedCount;
    console.log(`   Status breakdown: ~${openedCount} opened, ~${resolvedCount} resolved, ~${closedCount} closed`);
  }

  protected async createGradebookColumns(
    config: SeedingConfiguration,
    class_id: number,
    students: TestingUser[],
    assignments: Array<{ id: number; title: string }>
  ) {
    console.log(`\n📊 Creating gradebook columns using ${config.gradingScheme} scheme...`);

    if (config.gradingScheme === "specification") {
      await this.createSpecificationGradingColumns(class_id, students, assignments);
    } else {
      await this.createCurrentGradingColumns(class_id, students, config.numManualGradedColumns || 0);
    }
  }

  // Helper method to create specification grading scheme columns
  private async createSpecificationGradingColumns(
    class_id: number,
    students: TestingUser[],
    assignments: Array<{ id: number; title: string }>
  ) {
    console.log("   Creating specification grading scheme columns...");

    // Create skill columns (12 skills)
    const skillColumns = [];
    for (let i = 1; i <= 12; i++) {
      const skillColumn = await this.createGradebookColumn({
        class_id,
        name: `Skill #${i}`,
        description: `Score for skill #${i}`,
        slug: `skill-${i}`,
        max_score: 2,
        sort_order: 1 + i
      });

      // Update render expression separately
      await supabase
        .from("gradebook_columns")
        .update({ render_expression: 'customLabel(score,[2,"Meets";1,"Approach";0,"Not"])' })
        .eq("id", skillColumn.id);
      skillColumns.push(skillColumn);
    }

    // Create expectation level columns
    const skillColumnIds = skillColumns.map((col) => col.id);
    await this.createGradebookColumn({
      class_id,
      name: "Skills Meeting Expectations",
      description: "Total number of skills at meets expectations level",
      slug: "meets-expectations",
      score_expression: 'countif(gradebook_columns("skill-*"), f(x) = x.score == 2)',
      max_score: 12,
      dependencies: { gradebook_columns: skillColumnIds },
      sort_order: 14
    });

    await this.createGradebookColumn({
      class_id,
      name: "Skills Approaching Expectations",
      description: "Total number of skills at approaching expectations level",
      slug: "approaching-expectations",
      score_expression: 'countif(gradebook_columns("skill-*"), f(x) = x.score == 1)',
      max_score: 12,
      dependencies: { gradebook_columns: skillColumnIds },
      sort_order: 15
    });

    await this.createGradebookColumn({
      class_id,
      name: "Skills Not Meeting Expectations",
      description: "Total number of skills at does not meet expectations level",
      slug: "does-not-meet-expectations",
      score_expression: 'countif(gradebook_columns("skill-*"), f(x) = not x.is_missing and x.score == 0)',
      max_score: 12,
      dependencies: { gradebook_columns: skillColumnIds },
      sort_order: 16
    });

    await this.createGradebookColumn({
      class_id,
      name: "Total Labs",
      description: "Total number of labs",
      slug: "total-labs",
      score_expression: "countif(gradebook_columns('assignment-lab-*'), f(x) = not x.is_missing and x.score>0)",
      max_score: 10
    });

    await this.createGradebookColumn({
      class_id,
      name: "Average HW",
      description: "Average of all homework assignments",
      slug: "average.hw",
      score_expression: "mean(gradebook_columns('assignment-hw-*'))",
      max_score: 100,
      sort_order: 17
    });

    // Create final grade column
    const finalColumn = await this.createGradebookColumn({
      class_id,
      name: "Final Score",
      description: `Grades will be primarily assigned by achievement levels of the course Skills, with required grade thresholds on HW for each letter grade, and + (other than A) given for participation in 8 or more out of 10 labs, - given for participating in fewer than 6 out of ten labs.
Grade | Skills Needed | HW Needed
-- | -- | --
A | Meets expectations on 10+/12, Approaching expectations on remainder | 85% or better
B | Meets expectations on 8+/12, Approaching expectations on remainder | 75% or better
C | Meets expectations on 5+/12, Approaching expectations on remainder | 65% or better
D | Approaching expectations or better on 9+/12 | 55% or better`,
      slug: "final",
      score_expression: `CriteriaA = gradebook_columns("meets-expectations") >= 10 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 85
CriteriaB = gradebook_columns("meets-expectations") >= 8 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 75
CriteriaC = gradebook_columns("meets-expectations") >= 5 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 65
CriteriaD = gradebook_columns("approaching-expectations") >= 9 and gradebook_columns("does-not-meet-expectations") == 0 and gradebook_columns("average.hw") >= 55
CriteriaPlus = gradebook_columns("total-labs") >= 8
CriteriaMinus = gradebook_columns("total-labs") < 6
letter = case_when([CriteriaA, 95;
CriteriaB, 85;
CriteriaC, 75;
CriteriaD, 65;
true, 0])
mod = case_when([CriteriaPlus, 3;
CriteriaMinus, -3;
true, 0])
final = max(letter + mod, 0)
final;`,
      max_score: 100,
      sort_order: 34
    });

    // Update render expression separately
    await supabase.from("gradebook_columns").update({ render_expression: "letter(score)" }).eq("id", finalColumn.id);

    // Set scores for skill columns using specified distribution
    console.log("   Setting skill column scores...");
    const shuffledStudents = [...students].sort(() => Math.random() - 0.5);
    const excellent = shuffledStudents.slice(0, Math.floor(students.length * 0.9)); // 90%
    const good = shuffledStudents.slice(Math.floor(students.length * 0.9), Math.floor(students.length * 0.95)); // 5%

    for (let i = 0; i < skillColumns.length; i++) {
      const skillColumn = skillColumns[i];

      // Create custom score distribution for this skill
      const customScores = students.map((student, index) => {
        const studentCategory =
          index < excellent.length ? "excellent" : index < excellent.length + good.length ? "good" : "random";

        if (studentCategory === "excellent") {
          // 90% of students: 10+ skills at 2, none at 0
          if (i < 10) {
            return Math.random() < 0.9 ? 2 : 1; // First 10 skills: mostly 2s, some 1s
          } else {
            return Math.random() < 0.7 ? 2 : 1; // Remaining 2 skills: mix of 1s and 2s
          }
        } else if (studentCategory === "good") {
          // 5% of students: 8-9 skills at 2, none at 0
          if (i < 8) {
            return Math.random() < 0.85 ? 2 : 1; // First 8 skills: mostly 2s, some 1s
          } else if (i < 10) {
            return Math.random() < 0.5 ? 2 : 1; // Skills 9-10: mix of 1s and 2s
          } else {
            return Math.random() < 0.3 ? 2 : 1; // Remaining skills: mostly 1s
          }
        } else {
          // 5% of students: completely random distribution
          return [0, 1, 2][Math.floor(Math.random() * 3)];
        }
      });

      // Set custom scores for this skill column
      await this.setCustomGradebookColumnScores({
        class_id,
        gradebook_column_id: skillColumn.id,
        students,
        customScores
      });

      const avgScore = customScores.reduce((sum, s) => sum + s, 0) / customScores.length;
      console.log(`   ✓ Set ${skillColumn.name} scores: avg=${avgScore.toFixed(2)}`);
    }

    console.log(`   ✓ Created specification grading scheme with ${skillColumns.length} skills and aggregate columns`);
  }

  // Helper method to create current grading scheme columns
  private async createCurrentGradingColumns(class_id: number, students: TestingUser[], numManualGradedColumns: number) {
    console.log("   Creating current grading scheme columns...");

    // Create manual graded columns if specified
    const manualGradedColumns: Array<{
      id: number;
      name: string;
      slug: string;
      max_score: number | null;
      score_expression: string | null;
    }> = [];

    if (numManualGradedColumns > 0) {
      console.log(`   Creating ${numManualGradedColumns} manual graded columns...`);

      for (let i = 1; i <= numManualGradedColumns; i++) {
        const columnName = `Manual Grade ${i}`;
        const columnSlug = `manual-grade-${i}`;

        const manualColumn = await this.createGradebookColumn({
          class_id,
          name: columnName,
          description: `Manual grading column ${i}`,
          slug: columnSlug,
          max_score: 100,
          sort_order: 1000 + i
        });

        manualGradedColumns.push(manualColumn);
      }

      console.log(`   ✓ Created ${manualGradedColumns.length} manual graded columns`);
    }

    const participationColumn = await this.createGradebookColumn({
      class_id,
      name: "Participation",
      description: "Overall class participation score",
      slug: "participation",
      max_score: 100,
      sort_order: 1000
    });

    await this.createGradebookColumn({
      class_id,
      name: "Average HW",
      description: "Average of all homework assignments",
      slug: "average.hw",
      score_expression: "mean(gradebook_columns('assignment-assignment-*'))",
      max_score: 100,
      sort_order: 2
    });

    await this.createGradebookColumn({
      class_id,
      name: "Average Lab Assignments",
      description: "Average of all lab assignments",
      slug: "average-lab-assignments",
      score_expression: "mean(gradebook_columns('assignment-lab-*'))",
      max_score: 100,
      sort_order: 3
    });

    await this.createGradebookColumn({
      class_id,
      name: "Final Grade",
      description: "Calculated final grade",
      slug: "final-grade",
      score_expression:
        "gradebook_columns('average-lab-assignments') * 0.4 + gradebook_columns('average-assignments') * 0.5 + gradebook_columns('participation') * 0.1",
      max_score: 100,
      sort_order: 999
    });

    console.log(
      `   ✓ Created ${4 + manualGradedColumns.length} gradebook columns (${4} standard + ${manualGradedColumns.length} manual)`
    );

    // Set scores for the participation column using normal distribution
    console.log("   Setting scores for gradebook columns...");
    const participationStats = await this.setGradebookColumnScores({
      class_id,
      gradebook_column_id: participationColumn.id,
      students,
      averageScore: 85,
      standardDeviation: 12,
      maxScore: 100
    });
    console.log(
      `   ✓ Set participation scores: avg=${participationStats.averageActual}, min=${participationStats.minScore}, max=${participationStats.maxScore}`
    );

    // Set scores for manual graded columns using normal distribution
    if (manualGradedColumns.length > 0) {
      console.log("   Setting scores for manual graded columns...");
      for (const manualColumn of manualGradedColumns) {
        const manualStats = await this.setGradebookColumnScores({
          class_id,
          gradebook_column_id: manualColumn.id,
          students,
          averageScore: 80 + Math.random() * 20, // Random average between 80-100
          standardDeviation: 10 + Math.random() * 10, // Random deviation between 10-20
          maxScore: 100
        });
        console.log(
          `\n   ✓ Set ${manualColumn.name} scores: avg=${manualStats.averageActual}, min=${manualStats.minScore}, max=${manualStats.maxScore}`
        );
      }
    }

    return manualGradedColumns;
  }

  // Helper method to create a gradebook column
  private async createGradebookColumn({
    class_id,
    name,
    description,
    slug,
    max_score,
    score_expression,
    dependencies,
    released = false,
    sort_order
  }: {
    class_id: number;
    name: string;
    description?: string;
    slug: string;
    max_score?: number;
    score_expression?: string;
    dependencies?: { assignments?: number[]; gradebook_columns?: number[] };
    released?: boolean;
    sort_order?: number;
  }): Promise<{
    id: number;
    name: string;
    slug: string;
    max_score: number | null;
    score_expression: string | null;
  }> {
    // Get the gradebook for this class
    const { data: gradebook, error: gradebookError } = await supabase
      .from("gradebooks")
      .select("id")
      .eq("class_id", class_id)
      .single();

    if (gradebookError || !gradebook) {
      throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
    }

    // Create the gradebook column
    const { data: column, error: columnError } = await this.rateLimitManager.trackAndLimit("gradebook_columns", () =>
      supabase
        .from("gradebook_columns")
        .insert({
          class_id,
          gradebook_id: gradebook.id,
          name,
          description,
          slug,
          max_score,
          score_expression,
          dependencies,
          released,
          sort_order
        })
        .select("id, name, slug, max_score, score_expression")
    );
    if (columnError) {
      throw new Error(`Failed to create gradebook column ${name}: ${columnError.message}`);
    }

    return column[0];
  }

  // Helper method to set custom scores for students in a gradebook column
  private async setCustomGradebookColumnScores({
    class_id,
    gradebook_column_id,
    students,
    customScores
  }: {
    class_id: number;
    gradebook_column_id: number;
    students: TestingUser[];
    customScores: number[];
  }): Promise<void> {
    // Get the gradebook_id for this class
    const { data: gradebook, error: gradebookError } = await supabase
      .from("gradebooks")
      .select("id")
      .eq("class_id", class_id)
      .single();

    if (gradebookError || !gradebook) {
      throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
    }

    // Get existing gradebook column student records
    const existingRecords: { id: number; student_id: string }[] = [];
    let page = 0;
    const pageSize = 500;

    while (true) {
      const { data: pageData, error: fetchError } = await this.rateLimitManager.trackAndLimit(
        "gradebook_column_students",
        () =>
          supabase
            .from("gradebook_column_students")
            .select("id, student_id")
            .eq("gradebook_column_id", gradebook_column_id)
            .eq("is_private", true)
            .range(page * pageSize, (page + 1) * pageSize - 1)
      );

      if (fetchError) {
        throw new Error(`Failed to fetch existing gradebook column students: ${fetchError.message}`);
      }

      if (!pageData || pageData.length === 0) {
        break;
      }

      existingRecords.push(...pageData);

      // If we got less than the page size, we've reached the end
      if (pageData.length < pageSize) {
        break;
      }

      page++;
    }

    if (!existingRecords || existingRecords.length === 0) {
      throw new Error(`No existing gradebook column student records found for column ${gradebook_column_id}`);
    }

    const updatePromises = students.map(async (student, index) => {
      const existingRecord = existingRecords.find((record) => record.student_id === student.private_profile_id);
      if (!existingRecord) {
        console.warn(`No gradebook column student record found for student ${student.email}`);
        return;
      }

      const { error: updateError } = await this.rateLimitManager.trackAndLimit("gradebook_column_students", () =>
        supabase
          .from("gradebook_column_students")
          .update({ score: customScores[index] })
          .eq("id", existingRecord.id)
          .select("id")
      );

      if (updateError) {
        throw new Error(`Failed to update score for student ${student.email}: ${updateError.message}`);
      }
    });

    await Promise.all(updatePromises);
  }

  // Helper method to set scores for students in a gradebook column using normal distribution
  private async setGradebookColumnScores({
    class_id,
    gradebook_column_id,
    students,
    averageScore,
    standardDeviation = 15,
    maxScore = 100
  }: {
    class_id: number;
    gradebook_column_id: number;
    students: TestingUser[];
    averageScore: number;
    standardDeviation?: number;
    maxScore?: number;
  }): Promise<{
    updatedCount: number;
    averageActual: number;
    minScore: number;
    maxScore: number;
  }> {
    // Generate scores using normal distribution
    const scores = students.map(() => {
      // Generate normal distribution using Box-Muller transform
      const u1 = Math.random();
      const u2 = Math.random();
      const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      // Apply to our distribution
      let score = averageScore + z0 * standardDeviation;

      // Clamp to valid range (0 to maxScore)
      score = Math.max(0, Math.min(maxScore, score));

      return Math.round(score * 100) / 100; // Round to 2 decimal places
    });

    // Get the gradebook_id for this class
    const { data: gradebook, error: gradebookError } = await supabase
      .from("gradebooks")
      .select("id")
      .eq("class_id", class_id)
      .single();

    if (gradebookError || !gradebook) {
      throw new Error(`Failed to find gradebook for class ${class_id}: ${gradebookError?.message}`);
    }

    // Get existing gradebook column student records
    const { data: existingRecords, error: fetchError } = await supabase
      .from("gradebook_column_students")
      .select("id, student_id")
      .eq("gradebook_column_id", gradebook_column_id)
      .eq("is_private", true);

    if (fetchError) {
      throw new Error(`Failed to fetch existing gradebook column students: ${fetchError.message}`);
    }

    if (!existingRecords || existingRecords.length === 0) {
      throw new Error(`No existing gradebook column student records found for column ${gradebook_column_id}`);
    }

    // Update scores for each student individually
    const updatePromises = students.map(async (student, index) => {
      const existingRecord = existingRecords.find((record) => record.student_id === student.private_profile_id);
      if (!existingRecord) {
        console.warn(`No gradebook column student record found for student ${student.email}`);
        return;
      }

      const { error: updateError } = await this.rateLimitManager.trackAndLimit("gradebook_column_students", () =>
        supabase
          .from("gradebook_column_students")
          .update({ score: scores[index] })
          .eq("id", existingRecord.id)
          .select("id")
      );

      if (updateError) {
        throw new Error(`Failed to update score for student ${student.email}: ${updateError.message}`);
      }
    });

    await Promise.all(updatePromises);

    // Calculate statistics
    const actualAverage = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxActualScore = Math.max(...scores);

    return {
      updatedCount: students.length,
      averageActual: Math.round(actualAverage * 100) / 100,
      minScore: Math.round(minScore * 100) / 100,
      maxScore: Math.round(maxActualScore * 100) / 100
    };
  }

  protected async createHelpRequests(
    config: HelpRequestConfig,
    class_id: number,
    students: TestingUser[],
    instructors: TestingUser[],
    graders: TestingUser[]
  ) {
    console.log(`\n🆘 Creating ${config.numHelpRequests} help requests...`);

    // First, create a help queue if it doesn't exist
    const { data: existingQueue } = await supabase.from("help_queues").select("id").eq("class_id", class_id).single();

    let queueId: number;
    if (existingQueue) {
      queueId = existingQueue.id;
    } else {
      const { data: queueData, error: queueError } = await supabase
        .from("help_queues")
        .insert({
          class_id: class_id,
          name: "Office Hours",
          description: "General office hours help queue",
          depth: 1,
          queue_type: "video"
        })
        .select("id")
        .single();

      if (queueError) {
        throw new Error(`Failed to create help queue: ${queueError.message}`);
      }
      queueId = queueData.id;
    }

    // Create help requests in batches
    const BATCH_SIZE = 50;
    const helpRequestBatches = chunkArray(
      Array.from({ length: config.numHelpRequests }, (_, i) => i),
      BATCH_SIZE
    );

    let totalCreated = 0;
    let totalResolved = 0;

    for (const batch of helpRequestBatches) {
      console.log(
        `  Creating help requests batch ${helpRequestBatches.indexOf(batch) + 1}/${helpRequestBatches.length}...`
      );

      const batchPromises = batch.map(async () => {
        // Select a random student as the creator
        const creator = students[Math.floor(Math.random() * students.length)];
        const isPrivate = Math.random() < 0.3; // 30% chance of being private
        const isResolved = Math.random() < 0.8; // 80% chance of being resolved
        const status = isResolved ? (Math.random() < 0.5 ? "resolved" : "closed") : "open";

        // Select a random help request template
        const messageTemplate = HELP_REQUEST_TEMPLATES[Math.floor(Math.random() * HELP_REQUEST_TEMPLATES.length)];

        // Create the help request
        const { data: helpRequestData, error: helpRequestError } = await this.rateLimitManager.trackAndLimit(
          "help_requests",
          () =>
            supabase
              .from("help_requests")
              .insert({
                class_id: class_id,
                help_queue: queueId,
                request: messageTemplate,
                is_private: isPrivate,
                status: status,
                created_by: creator.private_profile_id,
                assignee: isResolved
                  ? instructors[Math.floor(Math.random() * instructors.length)].private_profile_id
                  : null,
                resolved_at: isResolved
                  ? new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString()
                  : null // Random time in last 7 days
              })
              .select("id")
        );

        if (helpRequestError) {
          throw new Error(`Failed to create help request: ${helpRequestError.message}`);
        }

        const helpRequestId = helpRequestData[0].id;

        // Add the creator as a member
        await this.rateLimitManager.trackAndLimit("help_request_students", () =>
          supabase
            .from("help_request_students")
            .insert({
              help_request_id: helpRequestId,
              profile_id: creator.private_profile_id,
              class_id: class_id
            })
            .select("id")
        );

        // Add additional members (1 to maxMembersPerRequest total members)
        const numMembers = Math.floor(Math.random() * config.maxMembersPerRequest) + 1;
        const additionalMembers = Math.min(numMembers - 1, students.length - 1); // -1 because creator is already added

        if (additionalMembers > 0) {
          const availableStudents = students.filter((s) => s.private_profile_id !== creator.private_profile_id);
          const selectedMembers = availableStudents.sort(() => Math.random() - 0.5).slice(0, additionalMembers);

          const memberInserts = selectedMembers.map((student) => ({
            help_request_id: helpRequestId,
            profile_id: student.private_profile_id,
            class_id: class_id
          }));

          if (memberInserts.length > 0) {
            await this.rateLimitManager.trackAndLimit(
              "help_request_students",
              () => supabase.from("help_request_students").insert(memberInserts).select("id"),
              memberInserts.length
            );
          }
        }

        // Create replies (messages)
        const numReplies =
          Math.floor(Math.random() * (config.maxRepliesPerRequest - config.minRepliesPerRequest + 1)) +
          config.minRepliesPerRequest;

        if (numReplies > 0) {
          const allParticipants = [creator, ...instructors];
          const messageInserts: Array<{
            help_request_id: number;
            author: string;
            message: string;
            class_id: number;
            instructors_only: boolean;
            created_at: string;
          }> = [];

          for (let i = 0; i < numReplies; i++) {
            const isFromInstructor = Math.random() < 0.4; // 40% chance message is from instructor
            const sender = isFromInstructor
              ? instructors[Math.floor(Math.random() * instructors.length)]
              : allParticipants[Math.floor(Math.random() * allParticipants.length)];

            const replyTemplate = HELP_REQUEST_REPLIES[Math.floor(Math.random() * HELP_REQUEST_REPLIES.length)];
            const messageTime = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000); // Random time in last 7 days

            messageInserts.push({
              help_request_id: helpRequestId,
              author: sender.private_profile_id,
              message: replyTemplate,
              class_id: class_id,
              instructors_only: isPrivate && Math.random() < 0.2, // 20% of private request messages are instructor-only
              created_at: messageTime.toISOString()
            });
          }

          if (messageInserts.length > 0) {
            await this.rateLimitManager.trackAndLimit(
              "help_request_messages",
              () => supabase.from("help_request_messages").insert(messageInserts).select("id"),
              messageInserts.length
            );
          }
        }

        if (isResolved) {
          totalResolved++;
        }
        totalCreated++;
      });

      await Promise.all(batchPromises);
    }

    console.log(
      `✓ Created ${totalCreated} help requests (${totalResolved} resolved/closed, ${totalCreated - totalResolved} open)`
    );
  }

  // Helper method to create rubric structure for an assignment
  private async createRubricForAssignment(assignment: Assignment, rubricConfig: RubricConfig) {
    const rubricStructure = generateRubricStructure(rubricConfig);

    // Create self-review rubric part (always include basic self-review)
    const selfReviewPart = {
      name: "Self Review",
      description: "Student self-assessment",
      ordinal: 0,
      criteria: [
        {
          name: "Self Assessment",
          description: "How well did you complete this assignment?",
          ordinal: 0,
          total_points: 10,
          checks: [
            {
              name: "Excellent",
              ordinal: 0,
              points: 10,
              is_annotation: false,
              is_comment_required: true,
              is_required: true
            },
            {
              name: "Good",
              ordinal: 1,
              points: 8,
              is_annotation: false,
              is_comment_required: true,
              is_required: false
            },
            {
              name: "Satisfactory",
              ordinal: 2,
              points: 6,
              is_annotation: false,
              is_comment_required: true,
              is_required: false
            },
            {
              name: "Needs Work",
              ordinal: 3,
              points: 4,
              is_annotation: false,
              is_comment_required: true,
              is_required: false
            }
          ]
        }
      ]
    };

    const allParts = [selfReviewPart, ...rubricStructure];

    await Promise.all(
      allParts.map(async (partTemplate) => {
        const isGradingPart = partTemplate.name !== "Self Review";
        const rubricId = isGradingPart ? assignment.grading_rubric_id : assignment.self_review_rubric_id;

        if (!rubricId) {
          console.warn(`Skipping rubric part ${partTemplate.name} - no rubric ID available`);
          return;
        }

        // Create rubric part
        const { data: partData, error: partError } = await this.rateLimitManager.trackAndLimit("rubric_parts", () =>
          supabase
            .from("rubric_parts")
            .insert({
              class_id: assignment.class_id,
              name: partTemplate.name,
              description: partTemplate.description,
              ordinal: partTemplate.ordinal,
              rubric_id: rubricId
            })
            .select("id")
        );

        if (partError || !partData || partData.length === 0) {
          throw new Error(`Failed to create rubric part: ${partError?.message || "No data returned"}`);
        }

        const partId = partData[0].id;

        // Create criteria for this part
        for (const criteriaTemplate of partTemplate.criteria) {
          const { data: criteriaData, error: criteriaError } = await this.rateLimitManager.trackAndLimit(
            "rubric_criteria",
            () =>
              supabase
                .from("rubric_criteria")
                .insert({
                  class_id: assignment.class_id,
                  name: criteriaTemplate.name,
                  description: criteriaTemplate.description,
                  ordinal: criteriaTemplate.ordinal,
                  total_points: criteriaTemplate.total_points,
                  is_additive: true,
                  rubric_part_id: partId,
                  rubric_id: rubricId
                })
                .select("id")
          );

          if (criteriaError || !criteriaData || criteriaData.length === 0) {
            throw new Error(`Failed to create rubric criteria: ${criteriaError?.message || "No data returned"}`);
          }

          const criteriaId = criteriaData[0].id;

          // Create checks for this criteria
          for (const checkTemplate of criteriaTemplate.checks) {
            await this.rateLimitManager.trackAndLimit("rubric_checks", () =>
              supabase
                .from("rubric_checks")
                .insert({
                  class_id: assignment.class_id,
                  rubric_criteria_id: criteriaId,
                  name: checkTemplate.name,
                  description: `${checkTemplate.name} evaluation`,
                  ordinal: checkTemplate.ordinal,
                  points: checkTemplate.points,
                  is_annotation: checkTemplate.is_annotation,
                  is_comment_required: checkTemplate.is_comment_required,
                  is_required: checkTemplate.is_required
                })
                .select("*")
            );
          }
        }
      })
    );
  }

  // Helper method to create assignment groups
  private async createAssignmentGroups(
    assignment_id: number,
    class_id: number,
    students: TestingUser[],
    groupSize: number
  ): Promise<Array<{ id: number; name: string; memberCount: number; members: string[] }>> {
    const groups: Array<{ id: number; name: string; memberCount: number; members: string[] }> = [];
    const numGroups = Math.ceil(students.length / groupSize);

    // Shuffle students for random group assignment
    const shuffledStudents = [...students].sort(() => Math.random() - 0.5);

    const createdGroups = await Promise.all(
      Array.from({ length: numGroups }).map(async (_, i) => {
        const groupStudents = shuffledStudents.slice(i * groupSize, (i + 1) * groupSize);

        if (groupStudents.length === 0) return null;

        // Create the group
        const { data: groupData, error: groupError } = await this.rateLimitManager.trackAndLimit(
          "assignment_groups",
          () =>
            supabase
              .from("assignment_groups")
              .insert({
                assignment_id: assignment_id,
                class_id: class_id,
                name: `group-${String.fromCharCode(65 + i)}` // A, B, C, etc.
              })
              .select("id, name")
        );

        if (groupError || !groupData || groupData.length === 0) {
          throw new Error(`Failed to create assignment group: ${groupError?.message || "No data returned"}`);
        }

        const group = groupData[0];

        // Add members to the group
        const memberInserts = groupStudents.map((student) => ({
          assignment_group_id: group.id,
          profile_id: student.private_profile_id,
          assignment_id: assignment_id,
          class_id: class_id,
          added_by: student.private_profile_id
        }));

        if (memberInserts.length > 0) {
          await this.rateLimitManager.trackAndLimit(
            "assignment_groups_members",
            () => supabase.from("assignment_groups_members").insert(memberInserts).select("*"),
            memberInserts.length
          );
        }

        return {
          id: group.id,
          name: group.name,
          memberCount: groupStudents.length,
          members: groupStudents.map((s) => s.private_profile_id)
        };
      })
    );

    // Filter out null results and add to groups array
    groups.push(...createdGroups.filter((group): group is NonNullable<typeof group> => group !== null));

    return groups;
  }

  // Helper method to batch create submissions with repositories and files
  private async batchCreateSubmissions(
    submissionsToCreate: Array<{
      assignment: {
        id: number;
        due_date: string;
        title: string;
        groups?: Array<{ id: number; name: string; memberCount: number; members: string[] }>;
      };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      isRecentlyDue: boolean;
    }>,
    class_id: number
  ): Promise<
    Array<{
      submission_id: number;
      assignment: { id: number; due_date: string };
      student?: TestingUser;
      group?: { id: number; name: string; memberCount: number; members: string[] };
      repository_id?: number;
    }>
  > {
    if (submissionsToCreate.length === 0) {
      return [];
    }

    const batch_size = this.rateLimits["submissions"].batchSize || 100;
    const submissionChunks = chunkArray(submissionsToCreate, batch_size);
    const test_run_prefix = getTestRunPrefix();

    console.log(`   Processing ${submissionChunks.length} batches in parallel...`);

    // Process all chunks in parallel
    const chunkResults = await Promise.all(
      submissionChunks.map(async (chunk, chunkIndex) => {
        // Calculate unique repo counter base for this chunk to avoid conflicts
        const chunkRepoCounterBase = this.repoCounter + chunkIndex * batch_size;

        // Prepare repository data for this chunk
        const repositoryInserts = chunk.map((item, index) => ({
          assignment_id: item.assignment.id,
          repository: `pawtograder-playground/test-e2e-student-repo-java--${test_run_prefix}-${chunkRepoCounterBase + index}`,
          class_id: class_id,
          profile_id: item.student?.private_profile_id,
          assignment_group_id: item.group?.id,
          synced_handout_sha: "none"
        }));

        // Batch insert repositories for this chunk
        const { data: repositoryData, error: repositoryError } = await this.rateLimitManager.trackAndLimit(
          "repositories",
          () => supabase.from("repositories").insert(repositoryInserts).select("id"),
          repositoryInserts.length
        );

        if (repositoryError) {
          throw new Error(`Failed to batch create repositories (chunk ${chunkIndex + 1}): ${repositoryError.message}`);
        }

        // Prepare repository check runs for this chunk
        const checkRunInserts = repositoryData.map((repo) => ({
          class_id: class_id,
          repository_id: repo.id,
          check_run_id: 1,
          status: "{}",
          sha: "none",
          commit_message: "none"
        }));

        // Batch insert repository check runs for this chunk
        const { data: checkRunData, error: checkRunError } = await this.rateLimitManager.trackAndLimit(
          "repository_check_runs",
          () => supabase.from("repository_check_runs").insert(checkRunInserts).select("id"),
          checkRunInserts.length
        );

        if (checkRunError) {
          throw new Error(`Failed to batch create check runs (chunk ${chunkIndex + 1}): ${checkRunError.message}`);
        }

        // Prepare submissions for this chunk
        const submissionInserts = chunk.map((item, index) => ({
          assignment_id: item.assignment.id,
          profile_id: item.student?.private_profile_id,
          assignment_group_id: item.group?.id,
          sha: "none",
          repository: repositoryInserts[index].repository,
          run_attempt: 1,
          run_number: 1,
          class_id: class_id,
          repository_check_run_id: checkRunData[index].id,
          repository_id: repositoryData[index].id
        }));

        // Batch insert submissions for this chunk
        const { data: submissionData, error: submissionError } = await this.rateLimitManager.trackAndLimit(
          "submissions",
          () => supabase.from("submissions").insert(submissionInserts).select("id"),
          submissionInserts.length
        );

        if (submissionError) {
          throw new Error(`Failed to batch create submissions (chunk ${chunkIndex + 1}): ${submissionError.message}`);
        }

        // Prepare submission files for this chunk
        const sampleJavaCode = `package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

  /*
   * This method takes two integers and returns their sum.
   * 
   * @param a the first integer
   * @param b the second integer
   * @return the sum of a and b
   */
  public int doMath(int a, int b) {
      return a+b;
  }

  /**
   * This method returns a message, "Hello, World!"
   * @return
   */
  public String getMessage() {
      
      return "Hello, World!";
  }
}`;

        const submissionFileInserts = submissionData.map((submission, index) => ({
          name: "sample.java",
          contents: sampleJavaCode,
          class_id: class_id,
          submission_id: submission.id,
          profile_id: chunk[index].student?.private_profile_id,
          assignment_group_id: chunk[index].group?.id
        }));

        // Batch insert submission files for this chunk
        const { error: submissionFileError } = await this.rateLimitManager.trackAndLimit(
          "submission_files",
          () => supabase.from("submission_files").insert(submissionFileInserts).select("id"),
          submissionFileInserts.length
        );

        if (submissionFileError) {
          throw new Error(
            `Failed to batch create submission files (chunk ${chunkIndex + 1}): ${submissionFileError.message}`
          );
        }

        // Prepare grader results for this chunk
        const graderResultInserts = submissionData.map((submission, index) => ({
          submission_id: submission.id,
          score: 5,
          class_id: class_id,
          profile_id: chunk[index].student?.private_profile_id,
          assignment_group_id: chunk[index].group?.id,
          lint_passed: true,
          lint_output: "no lint output",
          lint_output_format: "markdown",
          max_score: 10
        }));

        // Batch insert grader results for this chunk
        const { data: graderResultData, error: graderResultError } = await this.rateLimitManager.trackAndLimit(
          "grader_results",
          () => supabase.from("grader_results").insert(graderResultInserts).select("id"),
          graderResultInserts.length
        );

        if (graderResultError) {
          throw new Error(
            `Failed to batch create grader results (chunk ${chunkIndex + 1}): ${graderResultError.message}`
          );
        }

        // Prepare grader result tests (2 per submission) for this chunk
        const graderResultTestInserts = graderResultData.flatMap((graderResult, index) => [
          {
            score: 5,
            max_score: 5,
            name: "test 1",
            name_format: "text",
            output: "here is a bunch of output\n**wow**",
            output_format: "markdown",
            class_id: class_id,
            student_id: chunk[index].student?.private_profile_id,
            assignment_group_id: chunk[index].group?.id,
            grader_result_id: graderResult.id,
            is_released: true
          },
          {
            score: 5,
            max_score: 5,
            name: "test 2",
            name_format: "text",
            output: "here is a bunch of output\n**wow**",
            output_format: "markdown",
            class_id: class_id,
            student_id: chunk[index].student?.private_profile_id,
            assignment_group_id: chunk[index].group?.id,
            grader_result_id: graderResult.id,
            is_released: true
          }
        ]);

        // Batch insert grader result tests for this chunk
        const { error: graderResultTestError } = await this.rateLimitManager.trackAndLimit(
          "grader_result_tests",
          () => supabase.from("grader_result_tests").insert(graderResultTestInserts).select("id"),
          graderResultTestInserts.length
        );

        if (graderResultTestError) {
          throw new Error(
            `Failed to batch create grader result tests (chunk ${chunkIndex + 1}): ${graderResultTestError.message}`
          );
        }

        // Return the results for this chunk
        return chunk.map((item, index) => ({
          submission_id: submissionData[index].id,
          assignment: { id: item.assignment.id, due_date: item.assignment.due_date },
          student: item.student,
          group: item.group,
          repository_id: repositoryData[index].id
        }));
      })
    );

    // Update repo counter for next batch
    this.repoCounter += submissionsToCreate.length;

    // Flatten results from all chunks
    return chunkResults.flat();
  }
}

// ============================
// USAGE EXAMPLES
// ============================

/**
 * Example usage of DatabaseSeeder with user recycling enabled (default):
 *
 * const seeder = new DatabaseSeeder()
 *   .withStudents(100)
 *   .withGraders(10)
 *   .withInstructors(3)
 *   .withAssignments(8)
 *   .withAssignmentDateRange(
 *     new Date('2024-01-15'),
 *     new Date('2024-05-15')
 *   )
 *   .withUserRecycling(true) // This is the default
 *   .withClassName("CS 2500 - Fundamentals of Computer Science");
 *
 * await seeder.seed();
 *
 * Example usage with user recycling disabled:
 *
 * const seeder = new DatabaseSeeder()
 *   .withStudents(50)
 *   .withGraders(5)
 *   .withInstructors(2)
 *   .withAssignments(5)
 *   .withAssignmentDateRange(
 *     new Date('2024-01-15'),
 *     new Date('2024-03-15')
 *   )
 *   .withUserRecycling(false) // Force creation of new users
 *   .withClassName("Test Class - No Recycling");
 *
 * await seeder.seed();
 */
