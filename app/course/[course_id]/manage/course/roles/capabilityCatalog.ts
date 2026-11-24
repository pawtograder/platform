import { capabilityLabel, INSTRUCTOR_ONLY_CAPABILITY } from "@/lib/classRoles";

export const CAPABILITY_AREAS = [
  "Manage Assignments",
  "Gradebook",
  "Office Hours",
  "Discussion",
  "Surveys",
  "Polls",
  "Course Settings"
] as const;
type CapabilityArea = (typeof CAPABILITY_AREAS)[number];
export type CapabilityCopy = { area: CapabilityArea; section: string; label: string; info: string };

// Includes capabilities in pending area PRs. Only database rows are rendered.
export const CAPABILITY_CATALOG = {
  manage_assignments: {
    area: "Manage Assignments",
    section: "Assignments",
    label: "Manage assignments",
    info: "Create and edit assignments in Manage Assignments, including their autograder settings. Also syncs student repositories from Repository Status."
  },
  manage_rubrics: {
    area: "Manage Assignments",
    section: "Rubrics",
    label: "Manage rubrics",
    info: "Create and edit grading rubrics under Manage Assignments > Configure Rubric."
  },
  manage_groups: {
    area: "Manage Assignments",
    section: "Groups",
    label: "Manage groups",
    info: "Set group mentors and copy groups from another assignment under Manage Assignments > Manage Groups."
  },
  publish_groups: {
    area: "Manage Assignments",
    section: "Groups",
    label: "Publish groups",
    info: "Create and edit groups and move students between them under Manage Assignments > Manage Groups. Publishing those changes still needs an instructor for now."
  },
  manage_review_assignments: {
    area: "Manage Assignments",
    section: "Reviews",
    label: "Manage review assignments",
    info: "Create, edit, delete, and clear review assignments under Manage Assignments > Grading Assignments."
  },
  grade_submissions: {
    area: "Manage Assignments",
    section: "Grading",
    label: "Grade submissions",
    info: "Grade student submissions using the assignment grading rubric."
  },
  handle_regrades: {
    area: "Manage Assignments",
    section: "Grading",
    label: "Handle regrades",
    info: "Respond to student regrade requests under Manage Assignments > Manage Regrade Requests."
  },
  grant_extensions: {
    area: "Manage Assignments",
    section: "Grading",
    label: "Grant extensions",
    info: "Give students due-date extensions under Manage Assignments > Manage Due Date Exceptions."
  },
  manage_student_repositories: {
    area: "Manage Assignments",
    section: "Repositories",
    label: "Manage student repositories",
    info: "Retry repository creation and fix permissions under Manage Assignments > Repository Status. Also allows cleaning up individual repositories, which deletes their submissions and archives the repositories."
  },
  manage_gradebook: {
    area: "Gradebook",
    section: "Grades",
    label: "Manage gradebook",
    info: "View the staff Gradebook, create and arrange columns, import and release grades, and override scores. Also shows private grades on student profiles."
  },
  help_students: {
    area: "Office Hours",
    section: "Help requests",
    label: "Help students",
    info: "Take, assign, resolve, and moderate help requests in Office Hours. Chat as staff, manage queues, and record karma notes."
  },
  manage_office_hours: {
    area: "Office Hours",
    section: "Settings",
    label: "Manage office hours",
    info: "Create and edit help request templates and instructor settings in Office Hours."
  },
  moderate_discussion: {
    area: "Discussion",
    section: "Posts",
    label: "Moderate discussion",
    info: "Pin, edit, answer, merge, move, and hide posts in Discussion."
  },
  send_announcements: {
    area: "Course Settings",
    section: "Emailer",
    label: "Send announcements",
    info: "Send emails to the class from Course Settings > Emailer."
  },
  manage_surveys: {
    area: "Surveys",
    section: "Surveys",
    label: "Manage surveys",
    info: "Create, edit, publish, close, delete, and assign surveys on the Surveys page."
  },
  run_polls: {
    area: "Polls",
    section: "Live polls",
    label: "Run polls",
    info: "Create, edit, open, close, and delete live polls on the Polls page."
  },
  manage_roster: {
    area: "Course Settings",
    section: "Enrollments & sections",
    label: "Manage roster",
    info: "Add, remove, and invite students in Course Settings > Enrollments. Manage lab sections and rename class sections. Changing staff roles still requires an instructor."
  },
  manage_flashcards: {
    area: "Course Settings",
    section: "Flashcards",
    label: "Manage flashcards",
    info: "Create, edit, and delete decks and cards under Course Settings > Flashcard Decks."
  }
} satisfies Record<string, CapabilityCopy>;

export type CapabilityGroup = {
  area: CapabilityArea | "Other";
  sections: { name: string; capabilities: { name: string; label: string; info: string }[] }[];
};

export function groupCapabilities(rows: readonly { name: string; description: string }[]): CapabilityGroup[] {
  const catalog = new Map<string, CapabilityCopy>(Object.entries(CAPABILITY_CATALOG));
  const groups: CapabilityGroup[] = [];
  for (const area of [...CAPABILITY_AREAS, "Other"] as const) {
    const sections = new Map<string, CapabilityGroup["sections"][number]>();
    // Catalog order keeps related actions together, regardless of database row order.
    const names = [
      ...Object.keys(CAPABILITY_CATALOG),
      ...rows
        .map((row) => row.name)
        .filter((name) => !catalog.has(name))
        .sort()
    ];
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const name of names) {
      const row = byName.get(name);
      if (!row || name === INSTRUCTOR_ONLY_CAPABILITY) continue;
      const copy = catalog.get(name);
      if ((copy?.area ?? "Other") !== area) continue;
      const sectionName = copy?.section ?? "Other capabilities";
      let section = sections.get(sectionName);
      if (!section) {
        section = { name: sectionName, capabilities: [] };
        sections.set(sectionName, section);
      }
      section.capabilities.push({
        name,
        label: copy?.label ?? capabilityLabel(name),
        info: copy?.info ?? row.description
      });
    }
    if (sections.size) groups.push({ area, sections: [...sections.values()] });
  }
  return groups;
}
