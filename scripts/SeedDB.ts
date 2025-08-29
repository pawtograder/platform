/* eslint-disable no-console */
import { addDays } from "date-fns";
import { faker } from "@faker-js/faker";
import dotenv from "dotenv";

import {
  DatabaseSeeder,
  type RubricConfig,
  type SectionsAndTagsConfig,
  type LabAssignmentConfig,
  type GroupAssignmentConfig,
  type HelpRequestConfig,
  type DiscussionConfig
} from "./DatabaseSeedingUtils";

dotenv.config({ path: ".env.local" });

// ============================
// TEMPLATE CONFIGURATIONS
// ============================

interface SeederConfig {
  className?: string;
  students?: number;
  graders?: number;
  instructors?: number;
  assignments?: number;
  dateRangeStart?: number; // days relative to now
  dateRangeEnd?: number; // days relative to now
  manualGradedColumns?: number;
  rubricConfig?: RubricConfig;
  sectionsAndTags?: SectionsAndTagsConfig;
  labAssignments?: LabAssignmentConfig;
  groupAssignments?: GroupAssignmentConfig;
  helpRequests?: HelpRequestConfig;
  discussions?: DiscussionConfig;
  gradingScheme?: "current" | "specification";
  rateLimitOverrides?: Record<string, { maxInsertsPerSecond: number; description: string; batchSize?: number }>;
}

const TEMPLATES: Record<string, SeederConfig> = {
  micro: {
    className: "Micro Test Class",
    students: 30,
    graders: 1,
    instructors: 1,
    assignments: 2,
    dateRangeStart: -65,
    dateRangeEnd: -2,
    manualGradedColumns: 0,
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    },
    sectionsAndTags: {
      numClassSections: 1,
      numLabSections: 20,
      numStudentTags: 1,
      numGraderTags: 1
    },
    labAssignments: {
      numLabAssignments: 1,
      minutesDueAfterLab: 10
    },
    groupAssignments: {
      numGroupAssignments: 1,
      numLabGroupAssignments: 1
    },
    discussions: {
      postsPerTopic: 2,
      maxRepliesPerPost: 4
    },
    helpRequests: {
      numHelpRequests: 5,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 10,
      maxMembersPerRequest: 3
    },
    gradingScheme: "specification"
  },

  small: {
    className: "Small Scale Test Class",
    students: 50,
    graders: 5,
    instructors: 2,
    assignments: 20,
    dateRangeStart: -30,
    dateRangeEnd: 30,
    manualGradedColumns: 5,
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 4,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 3
    },
    sectionsAndTags: {
      numClassSections: 2,
      numLabSections: 2,
      numStudentTags: 2,
      numGraderTags: 4
    },
    labAssignments: {
      numLabAssignments: 10,
      minutesDueAfterLab: 60 // 1 hour
    },
    groupAssignments: {
      numGroupAssignments: 5,
      numLabGroupAssignments: 10
    },
    helpRequests: {
      numHelpRequests: 40,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 70,
      maxMembersPerRequest: 6
    },
    discussions: {
      postsPerTopic: faker.number.int({ min: 5, max: 16 }),
      maxRepliesPerPost: 16
    },
    gradingScheme: "specification"
  },

  large: {
    className: "Large Scale Test Class",
    students: 900,
    graders: 80,
    instructors: 10,
    assignments: 20,
    dateRangeStart: -60,
    dateRangeEnd: 50,
    manualGradedColumns: 20,
    rubricConfig: {
      minPartsPerAssignment: 3,
      maxPartsPerAssignment: 5,
      minCriteriaPerPart: 1,
      maxCriteriaPerPart: 2,
      minChecksPerCriteria: 2,
      maxChecksPerCriteria: 4
    },
    sectionsAndTags: {
      numClassSections: 10,
      numLabSections: 10,
      numStudentTags: 10,
      numGraderTags: 20
    },
    labAssignments: {
      numLabAssignments: 12,
      minutesDueAfterLab: 1440 // 24 hours
    },
    groupAssignments: {
      numGroupAssignments: 0, //11,
      numLabGroupAssignments: 0 //6
    },
    helpRequests: {
      numHelpRequests: 100,
      minRepliesPerRequest: 0,
      maxRepliesPerRequest: 300,
      maxMembersPerRequest: 5
    },
    discussions: {
      postsPerTopic: 40,
      maxRepliesPerPost: 10
    },
    gradingScheme: "specification",
    rateLimitOverrides: {
      assignments: {
        maxInsertsPerSecond: 1,
        description: "Assignment creation (large scale, lots of students, many gradebok columns!)"
      }
    }
  },

  custom: {
    className: "Custom Configuration Class",
    students: 100,
    graders: 10,
    instructors: 3,
    assignments: 15,
    dateRangeStart: -45,
    dateRangeEnd: 15,
    manualGradedColumns: 8,
    rubricConfig: {
      minPartsPerAssignment: 2,
      maxPartsPerAssignment: 3,
      minCriteriaPerPart: 2,
      maxCriteriaPerPart: 3,
      minChecksPerCriteria: 3,
      maxChecksPerCriteria: 4
    },
    sectionsAndTags: {
      numClassSections: 3,
      numLabSections: 4,
      numStudentTags: 5,
      numGraderTags: 8
    },
    labAssignments: {
      numLabAssignments: 6,
      minutesDueAfterLab: 720 // 12 hours
    },
    groupAssignments: {
      numGroupAssignments: 4,
      numLabGroupAssignments: 3
    },
    helpRequests: {
      numHelpRequests: 60,
      minRepliesPerRequest: 1,
      maxRepliesPerRequest: 15,
      maxMembersPerRequest: 4
    },
    discussions: {
      postsPerTopic: faker.number.int({ min: 8, max: 12 }),
      maxRepliesPerPost: 10
    },
    gradingScheme: "current",
    rateLimitOverrides: {}
  }
};

async function runSeeding(config: SeederConfig) {
  const now = new Date();

  // Use class name from environment variable if available, otherwise use config
  const className = process.env["CLASS_NAME"] || config.className || "Test Class";

  const seeder = new DatabaseSeeder(config.rateLimitOverrides);

  await seeder
    .withClassName(className)
    .withStudents(config.students!)
    .withGraders(config.graders!)
    .withInstructors(config.instructors!)
    .withAssignments(config.assignments!)
    .withAssignmentDateRange(addDays(now, config.dateRangeStart!), addDays(now, config.dateRangeEnd!))
    .withManualGradedColumns(config.manualGradedColumns!)
    .withRubricConfig(config.rubricConfig!)
    .withSectionsAndTags(config.sectionsAndTags!)
    .withLabAssignments(config.labAssignments!)
    .withGroupAssignments(config.groupAssignments!)
    .withHelpRequests(config.helpRequests!)
    .withDiscussions(config.discussions!)
    .withGradingScheme(config.gradingScheme!)
    .seed();
}

// ============================
// CLI SETUP AND MAIN EXECUTION
// ============================

interface CLIArgs {
  template: string;
  className?: string;
  students?: number;
  graders?: number;
  instructors?: number;
  assignments?: number;
  dateRangeStart?: number;
  dateRangeEnd?: number;
  manualGradedColumns?: number;
  gradingScheme?: "current" | "specification";
  classSections?: number;
  labSections?: number;
  studentTags?: number;
  graderTags?: number;
  labAssignments?: number;
  labDueMinutes?: number;
  groupAssignments?: number;
  labGroupAssignments?: number;
  helpRequests?: number;
  helpMinReplies?: number;
  helpMaxReplies?: number;
  helpMaxMembers?: number;
  discussionPosts?: number;
  discussionMaxReplies?: number;
  rubricMinParts?: number;
  rubricMaxParts?: number;
  rubricMinCriteria?: number;
  rubricMaxCriteria?: number;
  rubricMinChecks?: number;
  rubricMaxChecks?: number;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {
    template: "micro"
  };

  // Show help if requested
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--template":
      case "-t":
        if (nextArg && !nextArg.startsWith("--")) {
          result.template = nextArg;
          i++;
        }
        break;
      case "--class-name":
        if (nextArg && !nextArg.startsWith("--")) {
          result.className = nextArg;
          i++;
        }
        break;
      case "--students":
        if (nextArg && !nextArg.startsWith("--")) {
          result.students = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--graders":
        if (nextArg && !nextArg.startsWith("--")) {
          result.graders = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--instructors":
        if (nextArg && !nextArg.startsWith("--")) {
          result.instructors = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--assignments":
        if (nextArg && !nextArg.startsWith("--")) {
          result.assignments = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--date-range-start":
        if (nextArg && !nextArg.startsWith("--")) {
          result.dateRangeStart = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--date-range-end":
        if (nextArg && !nextArg.startsWith("--")) {
          result.dateRangeEnd = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--manual-graded-columns":
        if (nextArg && !nextArg.startsWith("--")) {
          result.manualGradedColumns = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--grading-scheme":
        if (nextArg && (nextArg === "current" || nextArg === "specification")) {
          result.gradingScheme = nextArg;
          i++;
        }
        break;
      case "--help-requests":
        if (nextArg && !nextArg.startsWith("--")) {
          result.helpRequests = parseInt(nextArg, 10);
          i++;
        }
        break;
      case "--discussion-posts":
        if (nextArg && !nextArg.startsWith("--")) {
          result.discussionPosts = parseInt(nextArg, 10);
          i++;
        }
        break;
    }
  }

  return result;
}

function showHelp() {
  console.log(`
seed-db [options]

Seed the database with test data

Options:
  -t, --template <template>           Use a predefined template configuration
                                      [choices: "micro", "small", "large", "custom"] [default: "micro"]
      --class-name <name>             Name for the test class
      
Core Options:
      --students <number>             Number of students to create
      --graders <number>              Number of graders to create
      --instructors <number>          Number of instructors to create
      --assignments <number>          Number of assignments to create

Assignment Options:
      --date-range-start <days>       Assignment date range start (days relative to now, can be negative)
      --date-range-end <days>         Assignment date range end (days relative to now, can be negative)
      --manual-graded-columns <num>   Number of manual graded columns to create
      --grading-scheme <scheme>       Grading scheme to use [choices: "current", "specification"]

Help Request Options:
      --help-requests <number>        Number of help requests to create

Discussion Options:
      --discussion-posts <number>     Posts per discussion topic

  -h, --help                         Show this help

Examples:
  npm run seed                                        Run with micro template (default)
  npm run seed -- --template large                   Run with large scale template
  npm run seed -- --template small --students 100    Use small template but override student count
  npm run seed -- --students 50 --graders 5 --assignments 10  Full custom configuration
  npm run seed -- --help                             Show detailed help
  
Environment Variables:
  CLASS_NAME                          Override class name
  SEED_SCENARIO                       Use template (backwards compatibility)
`);
}

async function main() {
  try {
    const argv = parseArgs();

    // Support backwards compatibility with SEED_SCENARIO environment variable
    let templateName = argv.template;
    if (process.env["SEED_SCENARIO"] && !process.argv.includes("--template") && !process.argv.includes("-t")) {
      const envScenario = process.env["SEED_SCENARIO"]!.toLowerCase();
      if (TEMPLATES[envScenario]) {
        templateName = envScenario;
        console.log(`📄 Using SEED_SCENARIO environment variable: ${envScenario}`);
      }
    }

    // Start with the selected template
    const template = TEMPLATES[templateName];
    if (!template) {
      throw new Error(`Unknown template: ${templateName}`);
    }

    console.log(`🚀 Starting database seeding with template: ${templateName}`);

    // Create merged configuration (template + CLI overrides)
    const config: SeederConfig = {
      ...template,
      // Override with CLI options if provided
      ...(argv.className && { className: argv.className }),
      ...(argv.students && { students: argv.students }),
      ...(argv.graders && { graders: argv.graders }),
      ...(argv.instructors && { instructors: argv.instructors }),
      ...(argv.assignments && { assignments: argv.assignments }),
      ...(argv.dateRangeStart !== undefined && { dateRangeStart: argv.dateRangeStart }),
      ...(argv.dateRangeEnd !== undefined && { dateRangeEnd: argv.dateRangeEnd }),
      ...(argv.manualGradedColumns !== undefined && { manualGradedColumns: argv.manualGradedColumns }),
      ...(argv.gradingScheme && { gradingScheme: argv.gradingScheme })
    };

    // Override help requests if specified
    if (argv.helpRequests !== undefined) {
      config.helpRequests = {
        ...template.helpRequests!,
        numHelpRequests: argv.helpRequests
      };
    }

    // Override discussions if specified
    if (argv.discussionPosts !== undefined) {
      config.discussions = {
        ...template.discussions!,
        postsPerTopic: argv.discussionPosts
      };
    }

    // Display final configuration
    console.log(`📊 Final Configuration:`);
    console.log(`   Template: ${templateName}`);
    console.log(`   Students: ${config.students}`);
    console.log(`   Graders: ${config.graders}`);
    console.log(`   Instructors: ${config.instructors}`);
    console.log(`   Assignments: ${config.assignments}`);
    console.log(`   Class Name: ${config.className}`);

    // Show which options were overridden
    const overrides = [];
    if (argv.students && argv.students !== template.students)
      overrides.push(`students (${template.students} → ${argv.students})`);
    if (argv.graders && argv.graders !== template.graders)
      overrides.push(`graders (${template.graders} → ${argv.graders})`);
    if (argv.instructors && argv.instructors !== template.instructors)
      overrides.push(`instructors (${template.instructors} → ${argv.instructors})`);
    if (argv.assignments && argv.assignments !== template.assignments)
      overrides.push(`assignments (${template.assignments} → ${argv.assignments})`);

    if (overrides.length > 0) {
      console.log(`🔧 Template overrides: ${overrides.join(", ")}`);
    }
    console.log("");

    await runSeeding(config);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}
