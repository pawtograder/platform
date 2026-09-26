/**
 * Default names for the sections a SIS import creates.
 *
 * Lives outside index.ts so it can be tested: index.ts calls Deno.serve() at the
 * top level, so importing it from a test would stand up a server.
 */

/**
 * Build the default name for a section being imported from SIS.
 *
 * Class sections get the instructor's surname appended, because a course that runs
 * several lectures at the same time is otherwise indistinguishable in a dropdown.
 * Lab sections keep the plain course-number-and-times format: the people SIS lists
 * against a lab are the lecture instructors, not whoever actually runs the lab.
 *
 * A section with no listed instructor keeps the plain format rather than gaining an
 * empty "()".
 */
export function buildSectionName(
  sectionType: "class" | "lab",
  course: string,
  meetingTimes: string,
  instructors: Array<{ first_name: string; last_name: string }>
): string {
  const courseNumber = course.split(" ")[1] || "Unknown";
  const base = `${courseNumber} - ${meetingTimes}`;

  if (sectionType !== "class") {
    return base;
  }

  const surnames = instructors.map((instructor) => instructor.last_name?.trim()).filter((name) => !!name);

  return surnames.length > 0 ? `${base} (${surnames.join(", ")})` : base;
}
