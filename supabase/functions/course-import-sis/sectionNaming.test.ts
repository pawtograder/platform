/**
 * Unit tests for the default section names a SIS import produces.
 *
 * The strings below are in the shape the SIS roster endpoint returns: `course` is
 * "<subject> <number>" and `meeting_times` is already a human-readable string.
 *
 * Run from supabase/functions:  deno test course-import-sis/sectionNaming.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { buildSectionName } from "./sectionNaming.ts";

const doe = { first_name: "Jane", last_name: "Doe" };
const smith = { first_name: "Al", last_name: "Smith" };

Deno.test("a class section carries the instructor's surname", () => {
  assertEquals(buildSectionName("class", "CS 3500", "MWF 9:15am-10:20am", [doe]), "3500 - MWF 9:15am-10:20am (Doe)");
});

Deno.test("co-taught class sections list every surname", () => {
  assertEquals(
    buildSectionName("class", "CS 3500", "MWF 9:15am-10:20am", [doe, smith]),
    "3500 - MWF 9:15am-10:20am (Doe, Smith)"
  );
});

Deno.test("a class section with no listed instructor keeps the plain name", () => {
  assertEquals(buildSectionName("class", "CS 3500", "MWF 9:15am-10:20am", []), "3500 - MWF 9:15am-10:20am");
});

Deno.test("a blank surname does not produce an empty parenthetical", () => {
  assertEquals(
    buildSectionName("class", "CS 3500", "MWF 9:15am-10:20am", [{ first_name: "Jane", last_name: "   " }]),
    "3500 - MWF 9:15am-10:20am"
  );
});

Deno.test("lab sections keep the pre-existing format even when SIS lists instructors", () => {
  assertEquals(buildSectionName("lab", "CS 3501", "T 2:30pm-4:10pm", [doe]), "3501 - T 2:30pm-4:10pm");
});

Deno.test("a course code with no number falls back to Unknown", () => {
  assertEquals(buildSectionName("class", "CS", "MWF 9:15am-10:20am", [doe]), "Unknown - MWF 9:15am-10:20am (Doe)");
});
