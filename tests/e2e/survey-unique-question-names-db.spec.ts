/**
 * DB-level coverage for `surveys_reject_duplicate_question_names`
 * (20261029120000_surveys_unique_question_names.sql): a survey whose questions share a name may
 * not become published, and a published survey's questions may not change while a duplicate
 * remains (#1005).
 *
 * Writes go through an authenticated INSTRUCTOR client, the way the survey form and the surveys
 * table publish. That also proves the trigger's helper functions are executable by
 * `authenticated`: since 20261015120000 a missing GRANT would fail every publish with 42501, and
 * a service-role-only suite would not notice.
 *
 * The trigger must not over-fire. Surveys published with duplicate names before the migration
 * exist in production, and closing them or moving their dates has to keep working. Such a row
 * cannot be created through the API once the trigger exists, so `seedPublishedBeforeTheCheck`
 * writes one directly with triggers off, standing in for a row that predates the migration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import type { Database, TablesInsert } from "@/utils/supabase/SupabaseTypes";
import { test, expect } from "../global-setup";
import { createAuthenticatedClient, createClass, createUsersInClass, supabase, type TestingUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

const DB_URL =
  process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Two questions on different pages with the builder's default name, which is how #1005 was found. */
const DUPLICATE_JSON = {
  pages: [
    {
      name: "page1",
      elements: [
        { type: "radiogroup", name: "question_1", title: "First", choices: ["1", "2", "3"], isRequired: true },
        { type: "comment", name: "notes", title: "Notes" }
      ]
    },
    {
      name: "page2",
      elements: [{ type: "radiogroup", name: "question_1", title: "Second", choices: ["4", "5", "6"] }]
    }
  ]
};

const UNIQUE_JSON = {
  pages: [
    DUPLICATE_JSON.pages[0],
    { name: "page2", elements: [{ ...DUPLICATE_JSON.pages[1].elements[0], name: "question_2" }] }
  ]
};

/** The instructor form stores the definition as a JSON string inside the jsonb column. */
const asFormWritesIt = (json: object) => JSON.stringify(json) as unknown as TablesInsert<"surveys">["json"];

test.describe("surveys whose questions share a name cannot be published", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let course: Course;
  let otherCourse: Course;
  let instructor: TestingUser;
  let instructorClient: SupabaseClient<Database>;

  const baseRow = (overrides: Partial<TablesInsert<"surveys">>): TablesInsert<"surveys"> => ({
    class_id: course.id,
    created_by: instructor.public_profile_id,
    assigned_to_all: true,
    allow_response_editing: false,
    json: asFormWritesIt(DUPLICATE_JSON),
    version: 1,
    status: "draft",
    title: "Duplicate names survey",
    description: "#1005",
    ...overrides
  });

  async function readStored(id: string) {
    const { data, error } = await supabase
      .from("surveys")
      .select("status, json, title, due_date")
      .eq("id", id)
      .single();
    if (error || !data) throw new Error(`Failed to read survey ${id}: ${error?.message}`);
    return data;
  }

  function expectDuplicateNameRejection(error: { code?: string; message: string; details?: string } | null) {
    expect(error, "publishing duplicate question names must be rejected").not.toBeNull();
    expect(error!.code, `expected SQLSTATE 23514 from the trigger, got ${error!.code}: ${error!.message}`).toBe(
      "23514"
    );
    expect(error!.details ?? "", "the error must come from this trigger, not another 23514").toContain(
      "surveys_reject_duplicate_question_names"
    );
    expect(error!.message, "the message names the repeated question and says how to fix it").toContain(
      'more than one question is named "question_1"'
    );
    expect(error!.message).toContain("Rename the repeats");
  }

  /**
   * A survey that was published with duplicate names before this check existed. Triggers are off
   * for this one statement (`session_replication_role = replica`), so the row skips the check the
   * way rows written before the migration did.
   */
  async function seedPublishedBeforeTheCheck(title: string): Promise<string> {
    const { data, error } = await supabase
      .from("surveys")
      .insert(baseRow({ title, json: DUPLICATE_JSON as unknown as TablesInsert<"surveys">["json"] }))
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to seed draft: ${error?.message}`);

    const pg = new Client({ connectionString: DB_URL });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL session_replication_role = replica");
      await pg.query("UPDATE public.surveys SET status = 'published' WHERE id = $1", [data.id]);
      await pg.query("COMMIT");
    } catch (e) {
      await pg.query("ROLLBACK");
      throw e;
    } finally {
      await pg.end();
    }
    expect((await readStored(data.id)).status).toBe("published");
    return data.id;
  }

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Survey Unique Names" });
    otherCourse = await createClass({ name: "E2E Survey Unique Names Copy Target" });
    [instructor] = await createUsersInClass([
      {
        role: "instructor",
        class_id: course.id,
        name: "Una Unique",
        email: `survey-unique-names-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
    instructorClient = await createAuthenticatedClient(instructor);
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    if (instructor) await logMagicLinksOnFailure([instructor]);
  });

  test("an instructor cannot create a survey as published when two questions share a name", async () => {
    const title = "Published on create";
    const { data, error } = await instructorClient
      .from("surveys")
      .insert(baseRow({ title, status: "published" }))
      .select("id");
    expectDuplicateNameRejection(error);
    expect(data ?? []).toHaveLength(0);

    const { data: rows } = await supabase.from("surveys").select("id").eq("class_id", course.id).eq("title", title);
    expect(rows ?? [], "no part of the rejected insert landed").toHaveLength(0);
  });

  test("an instructor can save a draft with duplicate names, cannot publish it, and can once it is fixed", async () => {
    const { data: draft, error: draftError } = await instructorClient
      .from("surveys")
      .insert(baseRow({ title: "Draft first" }))
      .select("id")
      .single();
    expect(draftError, `saving a draft with duplicates must work: ${draftError?.message}`).toBeNull();

    const { error: publishError } = await instructorClient
      .from("surveys")
      .update({ status: "published" })
      .eq("id", draft!.id)
      .select("id");
    expectDuplicateNameRejection(publishError);
    expect((await readStored(draft!.id)).status, "the survey stays a draft").toBe("draft");

    // Fixing the name in the same statement as publishing, the way the edit form saves.
    const { error: fixedError } = await instructorClient
      .from("surveys")
      .update({ status: "published", json: asFormWritesIt(UNIQUE_JSON) })
      .eq("id", draft!.id)
      .select("id");
    expect(fixedError, `publishing with unique names must work: ${fixedError?.message}`).toBeNull();
    expect((await readStored(draft!.id)).status).toBe("published");
  });

  test("a published survey's questions cannot change while a name is repeated", async () => {
    const { data: published, error } = await instructorClient
      .from("surveys")
      .insert(baseRow({ title: "Published then edited", status: "published", json: asFormWritesIt(UNIQUE_JSON) }))
      .select("id")
      .single();
    expect(error, `publishing with unique names must work: ${error?.message}`).toBeNull();

    const { error: editError } = await instructorClient
      .from("surveys")
      .update({ json: asFormWritesIt(DUPLICATE_JSON) })
      .eq("id", published!.id)
      .select("id");
    expectDuplicateNameRejection(editError);
    expect((await readStored(published!.id)).json).toEqual(asFormWritesIt(UNIQUE_JSON));
  });

  test("a survey published with duplicates before the check can still be edited, re-saved and closed", async () => {
    const id = await seedPublishedBeforeTheCheck("Published before the check");
    const newDue = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

    // What the edit form sends when an instructor only moves the due date: every column,
    // including `status: published` and the unchanged questions, now as a JSON string.
    const { error: editError } = await instructorClient
      .from("surveys")
      .update({
        title: "Published before the check (extended)",
        due_date: newDue,
        status: "published",
        json: asFormWritesIt(DUPLICATE_JSON)
      })
      .eq("id", id)
      .select("id");
    expect(editError, `an unrelated edit must not be rejected: ${editError?.message}`).toBeNull();
    const afterEdit = await readStored(id);
    expect(afterEdit.status).toBe("published");
    expect(new Date(afterEdit.due_date!).toISOString()).toBe(newDue);

    const { error: closeError } = await instructorClient
      .from("surveys")
      .update({ status: "closed" })
      .eq("id", id)
      .select("id");
    expect(closeError, `closing must not be rejected: ${closeError?.message}`).toBeNull();
    expect((await readStored(id)).status).toBe("closed");
  });

  test("copying a survey published with duplicates to another class, as the CLI does, is rejected", async () => {
    const id = await seedPublishedBeforeTheCheck("Copied by the CLI");
    const { data: source } = await supabase.from("surveys").select("*").eq("id", id).single();

    // The insert copySurveyToClass (supabase/functions/cli/utils/surveyCopy.ts) makes, with the
    // service-role client the CLI function uses: the source's status and questions, new ids.
    const { error } = await supabase
      .from("surveys")
      .insert({
        ...baseRow({}),
        class_id: otherCourse.id,
        title: source!.title,
        json: source!.json,
        status: source!.status,
        survey_id: crypto.randomUUID()
      })
      .select("id");
    expectDuplicateNameRejection(error);
  });
});
