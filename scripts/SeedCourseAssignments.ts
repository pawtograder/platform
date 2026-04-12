/* eslint-disable no-console */
/**
 * SeedCourseAssignments - Create placeholder assignments and gradebook columns from a course config file
 *
 * This script reads a course configuration file and creates:
 * - Homework assignments (from config.assignments)
 * - Lab assignments (from config.labs)
 * - Participation gradebook columns (from config.lectures)
 *
 * Usage:
 *   npm run seed:course-assignments -- --class-id 123 --config course.config.json --dry-run
 *   npm run seed:course-assignments -- --class-id 123 --participation-points 5
 */

import { createAdminClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { addDays, format, setHours, setMinutes, setSeconds, parseISO } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: ".env.local" });

const supabase = createAdminClient<Database>();

// ============================
// COURSE CONFIG TYPES
// ============================

interface LectureConfig {
  lectureId: string;
  dates: string[];
  topics: string[];
}

interface LabConfig {
  id: string;
  title: string;
  dates: string[];
  sections?: string[];
  url?: string;
  notes?: string;
}

interface HomeworkConfig {
  id: string;
  title: string;
  type: string;
  assignedDate: string;
  dueDate: string;
  dueTime: string;
  points: number;
  url?: string;
}

interface CourseConfig {
  courseCode: string;
  courseTitle: string;
  semester: string;
  timezone: string;
  startDate: string;
  endDate: string;
  lectures: LectureConfig[];
  labs: LabConfig[];
  assignments: HomeworkConfig[];
}

// ============================
// PLANNED ITEM TYPES
// ============================

interface PlannedAssignment {
  type: "Homework" | "Lab";
  title: string;
  slug: string;
  releaseDate: Date;
  dueDate: Date;
  points: number;
}

interface PlannedGradebookColumn {
  title: string;
  slug: string;
  points: number;
}

// ============================
// UTILITY FUNCTIONS
// ============================

/**
 * Calculate Monday 00:00 of the week containing the given date
 */
function getMondayOfWeek(date: Date, timezone: string): Date {
  // Convert to the course timezone
  const zonedDate = toZonedTime(date, timezone);
  const dayOfWeek = zonedDate.getDay(); // 0 = Sunday, 1 = Monday

  // Calculate days to go back to Monday
  let daysToMonday: number;
  if (dayOfWeek === 0) {
    // Sunday - go back 6 days to previous Monday
    daysToMonday = -6;
  } else {
    // Monday (1) through Saturday (6)
    daysToMonday = 1 - dayOfWeek;
  }

  const monday = addDays(zonedDate, daysToMonday);
  const mondayStartOfDay = setSeconds(setMinutes(setHours(monday, 0), 0), 0);

  // Convert back from course timezone to UTC
  return fromZonedTime(mondayStartOfDay, timezone);
}

/**
 * Calculate Friday 11:59pm of the week containing the given date
 */
function getFridayOfWeek(date: Date, timezone: string): Date {
  // Convert to the course timezone
  const zonedDate = toZonedTime(date, timezone);
  const dayOfWeek = zonedDate.getDay(); // 0 = Sunday, 5 = Friday

  // Calculate days until Friday
  let daysUntilFriday: number;
  if (dayOfWeek === 0) {
    // Sunday - go back 2 days to previous Friday
    daysUntilFriday = -2;
  } else if (dayOfWeek <= 5) {
    // Monday (1) through Friday (5)
    daysUntilFriday = 5 - dayOfWeek;
  } else {
    // Saturday (6) - go back 1 day to previous Friday
    daysUntilFriday = -1;
  }

  const friday = addDays(zonedDate, daysUntilFriday);
  const fridayEndOfDay = setSeconds(setMinutes(setHours(friday, 23), 59), 59);

  // Convert back from course timezone to UTC
  return fromZonedTime(fridayEndOfDay, timezone);
}

/**
 * Parse a date string and time in a specific timezone and return UTC Date
 */
function parseDateTimeInTimezone(dateStr: string, timeStr: string, timezone: string): Date {
  const [hours, minutes] = timeStr.split(":").map(Number);
  const localDate = parseISO(dateStr);
  const zonedDate = setSeconds(setMinutes(setHours(localDate, hours), minutes), 59);
  return fromZonedTime(zonedDate, timezone);
}

/**
 * Parse a date and set it to start of day (00:00) in the specified timezone
 */
function parseDateStartOfDay(dateStr: string, timezone: string): Date {
  const localDate = parseISO(dateStr);
  const zonedDate = setSeconds(setMinutes(setHours(localDate, 0), 0), 0);
  return fromZonedTime(zonedDate, timezone);
}

/**
 * Load and parse course config file
 */
function loadCourseConfig(configPath: string): CourseConfig {
  const resolvedPath = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Course config not found at ${resolvedPath}`);
  }
  const configContent = fs.readFileSync(resolvedPath, "utf-8");
  return JSON.parse(configContent) as CourseConfig;
}

// ============================
// ASSIGNMENT PLANNING
// ============================

function planHomeworkAssignments(config: CourseConfig, skipIds: Set<string>): PlannedAssignment[] {
  return config.assignments
    .filter((hw) => !skipIds.has(hw.id))
    .map((hw) => ({
      type: "Homework" as const,
      title: hw.title,
      slug: `hw-${hw.id}`,
      releaseDate: parseDateStartOfDay(hw.assignedDate, config.timezone),
      dueDate: parseDateTimeInTimezone(hw.dueDate, hw.dueTime, config.timezone),
      points: hw.points
    }));
}

function planLabAssignments(config: CourseConfig, skipIds: Set<string>, labPoints: number): PlannedAssignment[] {
  // Group labs by their id (without the -mon/-tue suffix) to avoid duplicates
  const uniqueLabs = new Map<string, LabConfig>();

  for (const lab of config.labs) {
    // Extract the base lab id (e.g., "lab2" from "lab2-mon" or "lab2-tue")
    const baseId = lab.id.replace(/-mon$|-tue$/, "");

    // Only keep the first occurrence of each lab
    if (!uniqueLabs.has(baseId)) {
      uniqueLabs.set(baseId, lab);
    }
  }

  return Array.from(uniqueLabs.entries())
    .filter(([baseId]) => !skipIds.has(baseId))
    .map(([baseId, lab]) => {
      // Use the first date from the lab's dates array
      const labDate = parseISO(lab.dates[0]);
      const mondayReleaseDate = getMondayOfWeek(labDate, config.timezone);
      const fridayDueDate = getFridayOfWeek(labDate, config.timezone);

      return {
        type: "Lab" as const,
        title: lab.title,
        slug: `lab-${baseId}`,
        releaseDate: mondayReleaseDate,
        dueDate: fridayDueDate,
        points: labPoints
      };
    });
}

function planParticipationColumns(
  config: CourseConfig,
  participationPoints: number,
  skipIds: Set<string>
): PlannedGradebookColumn[] {
  const columns: PlannedGradebookColumn[] = [];

  for (const lecture of config.lectures) {
    // Skip if lecture ID is in skip list
    if (skipIds.has(lecture.lectureId)) {
      continue;
    }

    for (const dateStr of lecture.dates) {
      const formattedDate = format(parseISO(dateStr), "MM/dd/yy");

      columns.push({
        title: `Participation ${formattedDate}`,
        slug: `participation-${format(parseISO(dateStr), "MMddyy")}`,
        points: participationPoints
      });
    }
  }

  return columns;
}

// ============================
// DRY RUN OUTPUT
// ============================

function printDryRunTable(assignments: PlannedAssignment[], gradebookColumns: PlannedGradebookColumn[]): void {
  // Assignments table
  console.log("\n📋 Dry Run - Assignments that would be created:\n");
  console.log(
    "┌──────────┬────────────────────────────────────────────────────────────┬────────────────────────────┬──────────────────────────┬──────────────────────────┬────────┐"
  );
  console.log(
    "│ Type     │ Title                                                      │ Slug                       │ Release Date             │ Due Date                 │ Points │"
  );
  console.log(
    "├──────────┼────────────────────────────────────────────────────────────┼────────────────────────────┼──────────────────────────┼──────────────────────────┼────────┤"
  );

  for (const assignment of assignments) {
    const type = assignment.type.padEnd(8);
    const title = assignment.title.substring(0, 58).padEnd(58);
    const slug = assignment.slug.substring(0, 26).padEnd(26);
    const releaseDate = format(assignment.releaseDate, "yyyy-MM-dd HH:mm").padEnd(24);
    const dueDate = format(assignment.dueDate, "yyyy-MM-dd HH:mm").padEnd(24);
    const points = String(assignment.points).padStart(6);
    console.log(`│ ${type} │ ${title} │ ${slug} │ ${releaseDate} │ ${dueDate} │ ${points} │`);
  }

  console.log(
    "└──────────┴────────────────────────────────────────────────────────────┴────────────────────────────┴──────────────────────────┴──────────────────────────┴────────┘"
  );

  // Gradebook columns table
  console.log("\n📊 Dry Run - Gradebook columns that would be created:\n");
  console.log(
    "┌────────────────────────────────────────────────────────────┬────────────────────────────────┬────────┐"
  );
  console.log(
    "│ Title                                                      │ Slug                           │ Points │"
  );
  console.log(
    "├────────────────────────────────────────────────────────────┼────────────────────────────────┼────────┤"
  );

  for (const column of gradebookColumns) {
    const title = column.title.substring(0, 58).padEnd(58);
    const slug = column.slug.substring(0, 30).padEnd(30);
    const points = String(column.points).padStart(6);
    console.log(`│ ${title} │ ${slug} │ ${points} │`);
  }

  console.log(
    "└────────────────────────────────────────────────────────────┴────────────────────────────────┴────────┘"
  );

  // Summary
  const homeworkCount = assignments.filter((a) => a.type === "Homework").length;
  const labCount = assignments.filter((a) => a.type === "Lab").length;

  console.log(`\n📊 Summary:`);
  console.log(`   Homework assignments: ${homeworkCount}`);
  console.log(`   Lab assignments: ${labCount}`);
  console.log(`   Participation gradebook columns: ${gradebookColumns.length}`);
  console.log(`   Total items: ${assignments.length + gradebookColumns.length}`);
}

// ============================
// DATABASE OPERATIONS
// ============================

async function getGradebookId(classId: number): Promise<number> {
  const { data, error } = await supabase.from("gradebooks").select("id").eq("class_id", classId).single();

  if (error) {
    throw new Error(`Failed to get gradebook for class ${classId}: ${error.message}`);
  }

  return data.id;
}

async function checkExistingAssignments(classId: number, slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();

  const { data, error } = await supabase.from("assignments").select("slug").eq("class_id", classId).in("slug", slugs);

  if (error) {
    throw new Error(`Failed to check existing assignments: ${error.message}`);
  }

  return new Set(data?.map((a) => a.slug).filter((s): s is string => s !== null) ?? []);
}

async function checkExistingGradebookColumns(classId: number, slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();

  const { data, error } = await supabase
    .from("gradebook_columns")
    .select("slug")
    .eq("class_id", classId)
    .in("slug", slugs);

  if (error) {
    throw new Error(`Failed to check existing gradebook columns: ${error.message}`);
  }

  return new Set(data?.map((c) => c.slug) ?? []);
}

async function createSelfReviewSetting(classId: number): Promise<number> {
  const { data, error } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: classId,
      enabled: false,
      deadline_offset: 2,
      allow_early: true
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create self review setting: ${error.message}`);
  }

  return data.id;
}

async function createAssignment(
  classId: number,
  assignment: PlannedAssignment,
  selfReviewSettingId: number
): Promise<void> {
  const { error } = await supabase.from("assignments").insert({
    class_id: classId,
    title: assignment.title,
    slug: assignment.slug,
    release_date: assignment.releaseDate.toISOString(),
    due_date: assignment.dueDate.toISOString(),
    total_points: assignment.points,
    has_autograder: false,
    has_handgrader: false,
    max_late_tokens: 0,
    group_config: "individual",
    allow_not_graded_submissions: true,
    self_review_setting_id: selfReviewSettingId
  });

  if (error) {
    throw new Error(`Failed to create assignment "${assignment.title}": ${error.message}`);
  }
}

async function createGradebookColumn(
  classId: number,
  gradebookId: number,
  column: PlannedGradebookColumn
): Promise<void> {
  const { error } = await supabase.from("gradebook_columns").insert({
    class_id: classId,
    gradebook_id: gradebookId,
    name: column.title,
    slug: column.slug,
    max_score: column.points,
    released: false
  });

  if (error) {
    throw new Error(`Failed to create gradebook column "${column.title}": ${error.message}`);
  }
}

async function createAssignments(
  classId: number,
  assignments: PlannedAssignment[]
): Promise<{ created: number; failed: number; skipped: number }> {
  if (assignments.length === 0) {
    return { created: 0, failed: 0, skipped: 0 };
  }

  console.log(`\n🚀 Creating ${assignments.length} assignments...\n`);

  // Check for existing assignments
  const slugs = assignments.map((a) => a.slug);
  const existingSlugs = await checkExistingAssignments(classId, slugs);

  if (existingSlugs.size > 0) {
    console.log(`⚠️  Found ${existingSlugs.size} existing assignments that will be skipped:`);
    for (const slug of existingSlugs) {
      console.log(`   - ${slug}`);
    }
    console.log("");
  }

  // Filter out existing assignments
  const newAssignments = assignments.filter((a) => !existingSlugs.has(a.slug));

  if (newAssignments.length === 0) {
    console.log("✅ All assignments already exist. Nothing to create.");
    return { created: 0, failed: 0, skipped: existingSlugs.size };
  }

  let created = 0;
  let failed = 0;

  for (const assignment of newAssignments) {
    try {
      const selfReviewSettingId = await createSelfReviewSetting(classId);
      await createAssignment(classId, assignment, selfReviewSettingId);
      console.log(`✓ Created assignment: ${assignment.title}`);
      created++;
    } catch (error) {
      console.error(`✗ Failed: ${assignment.title} - ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  return { created, failed, skipped: existingSlugs.size };
}

async function createGradebookColumns(
  classId: number,
  columns: PlannedGradebookColumn[]
): Promise<{ created: number; failed: number; skipped: number }> {
  if (columns.length === 0) {
    return { created: 0, failed: 0, skipped: 0 };
  }

  console.log(`\n📊 Creating ${columns.length} gradebook columns...\n`);

  // Get gradebook ID
  const gradebookId = await getGradebookId(classId);

  // Check for existing columns
  const slugs = columns.map((c) => c.slug);
  const existingSlugs = await checkExistingGradebookColumns(classId, slugs);

  if (existingSlugs.size > 0) {
    console.log(`⚠️  Found ${existingSlugs.size} existing gradebook columns that will be skipped:`);
    for (const slug of existingSlugs) {
      console.log(`   - ${slug}`);
    }
    console.log("");
  }

  // Filter out existing columns
  const newColumns = columns.filter((c) => !existingSlugs.has(c.slug));

  if (newColumns.length === 0) {
    console.log("✅ All gradebook columns already exist. Nothing to create.");
    return { created: 0, failed: 0, skipped: existingSlugs.size };
  }

  let created = 0;
  let failed = 0;

  for (const column of newColumns) {
    try {
      await createGradebookColumn(classId, gradebookId, column);
      console.log(`✓ Created gradebook column: ${column.title}`);
      created++;
    } catch (error) {
      console.error(`✗ Failed: ${column.title} - ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  return { created, failed, skipped: existingSlugs.size };
}

// ============================
// CLI PARSING
// ============================

interface CLIArgs {
  classId: number | null;
  configPath: string;
  participationPoints: number;
  labPoints: number;
  dryRun: boolean;
  help: boolean;
  skip: string[];
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    classId: null,
    configPath: "course.config.json",
    participationPoints: 5,
    labPoints: 10,
    dryRun: false,
    help: false,
    skip: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--class-id":
        if (nextArg && !nextArg.startsWith("--")) {
          result.classId = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--config":
      case "-c":
        if (nextArg && !nextArg.startsWith("--")) {
          result.configPath = nextArg;
          i++;
        }
        break;
      case "--participation-points":
        if (nextArg && !nextArg.startsWith("--")) {
          result.participationPoints = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--lab-points":
        if (nextArg && !nextArg.startsWith("--")) {
          result.labPoints = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--skip":
      case "-s":
        if (nextArg && !nextArg.startsWith("--")) {
          result.skip.push(nextArg);
          i++;
        }
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
seed-course-assignments - Create placeholder assignments and gradebook columns from a course config file

Usage:
  npm run seed:course-assignments -- [options]

Options:
  --class-id <id>              Required. The class ID to create assignments for.
  -c, --config <path>          Path to course config file (default: course.config.json)
  --participation-points <n>   Points for each participation gradebook column (default: 5)
  --lab-points <n>             Points for each lab assignment (default: 10)
  -s, --skip <id>              Skip creating a specific item by ID (can be repeated)
  --dry-run                    Preview what would be created without inserting
  -h, --help                   Show this help message

What gets created:
  - Homework assignments: From config.assignments with release_date from assignedDate
  - Lab assignments: From config.labs with release_date on Monday, due_date on Friday of the lab week
  - Participation: Gradebook columns (not assignments) for each lecture date

Skip IDs:
  - For homework: use the assignment id (e.g., "cyb1", "team-form")
  - For labs: use the lab id without -mon/-tue suffix (e.g., "lab1", "lab2")
  - For participation: use the lecture id (e.g., "l1-intro", "l2-data-in-jvm")

Examples:
  # Preview what would be created
  npm run seed:course-assignments -- --class-id 123 --dry-run

  # Create assignments and gradebook columns with default participation points (5)
  npm run seed:course-assignments -- --class-id 123

  # Create with custom participation points
  npm run seed:course-assignments -- --class-id 123 --participation-points 10

  # Skip specific items
  npm run seed:course-assignments -- --class-id 123 --skip cyb1 --skip lab1

  # Skip multiple items (short form)
  npm run seed:course-assignments -- --class-id 123 -s cyb1 -s l1-intro -s l2-data-in-jvm

  # Use a different config file
  npm run seed:course-assignments -- --class-id 123 --config /path/to/config.json
`);
}

// ============================
// MAIN
// ============================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.classId === null) {
    console.error("❌ Error: --class-id is required");
    showHelp();
    process.exit(1);
  }

  console.log(`📚 Loading course configuration from ${args.configPath}...`);
  const config = loadCourseConfig(args.configPath);
  console.log(`   Course: ${config.courseCode} - ${config.courseTitle}`);
  console.log(`   Semester: ${config.semester}`);
  console.log(`   Timezone: ${config.timezone}`);

  // Create skip set
  const skipIds = new Set(args.skip);
  if (skipIds.size > 0) {
    console.log(`\n⏭️  Skipping ${skipIds.size} item(s): ${args.skip.join(", ")}`);
  }

  // Plan all items
  console.log("\n📝 Planning assignments and gradebook columns...");
  const homeworkAssignments = planHomeworkAssignments(config, skipIds);
  const labAssignments = planLabAssignments(config, skipIds, args.labPoints);
  const participationColumns = planParticipationColumns(config, args.participationPoints, skipIds);

  const allAssignments = [...homeworkAssignments, ...labAssignments];

  // Sort assignments by due date
  allAssignments.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  // Sort gradebook columns by slug (which contains date)
  participationColumns.sort((a, b) => a.slug.localeCompare(b.slug));

  if (args.dryRun) {
    printDryRunTable(allAssignments, participationColumns);
    console.log("\n🔍 Dry run complete. No changes were made.");
  } else {
    const assignmentResults = await createAssignments(args.classId, allAssignments);
    const columnResults = await createGradebookColumns(args.classId, participationColumns);

    console.log("\n📊 Final Results:");
    console.log(`   Assignments created: ${assignmentResults.created}`);
    console.log(`   Assignments failed: ${assignmentResults.failed}`);
    console.log(`   Assignments skipped: ${assignmentResults.skipped}`);
    console.log(`   Gradebook columns created: ${columnResults.created}`);
    console.log(`   Gradebook columns failed: ${columnResults.failed}`);
    console.log(`   Gradebook columns skipped: ${columnResults.skipped}`);
    console.log("\n✅ Seeding complete!");
  }
}

// Run if executed directly
main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
