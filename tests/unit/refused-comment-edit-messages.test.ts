/**
 * @jest-environment node
 *
 * Editing a comment that RLS won't let you change shows why (#983, Jon's review on #1246).
 *
 * The UPDATE policy on submission_comments only matches a grader's own comment while its review is
 * unreleased, so after release the UPDATE matches 0 rows. TableController.update ends in
 * `.select("*").single()`, which turns that into PGRST116, and the mapper used to show "Nothing was
 * found for this request" for it. TableController now throws refusedWriteError for that PGRST116
 * (lib/TableController.ts), so the released-review and self-review messages are reachable.
 *
 * These tests go through a real TableController with PostgREST's responses stubbed, then through the
 * mapper with the context rubric-sidebar.tsx's handleEditComment passes.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController from "@/lib/TableController";
import {
  getStudentFacingErrorMessage,
  getUserFacingErrorMessage,
  GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE
} from "@/lib/studentFacingErrorMessages";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/** What PostgREST answers when `.single()` gets 0 rows: here, an UPDATE that RLS refused. */
const PGRST116 = {
  code: "PGRST116",
  details: "The result contains 0 rows",
  hint: null,
  message: "JSON object requested, multiple (or no) rows returned"
};

const NOT_FOUND_MESSAGE = "Nothing was found for this request. It may have been removed or you may not have access.";

/** A submission_comments controller holding comment 7, whose PATCH PostgREST answers with PGRST116. */
function controllerWhoseUpdateMatchesNothing() {
  const fetchStub = jest.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (method !== "PATCH") throw new Error(`unexpected ${method} ${input.toString()}`);
    return new Response(JSON.stringify(PGRST116), { status: 406, headers: { "Content-Type": "application/json" } });
  });
  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;
  return new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from("submission_comments").select("*").eq("class_id", 1) as any,
    client,
    table: "submission_comments",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialData: [{ id: 7, comment: "original", deleted_at: null }] as any,
    loadEntireTable: true
  });
}

/** Runs the edit the way handleEditComment does and returns what it rejected with. */
async function editError(): Promise<unknown> {
  const controller = controllerWhoseUpdateMatchesNothing();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await controller.update(7, { comment: "edited" } as any).then(
      () => {
        throw new Error("expected the update to reject");
      },
      (error: unknown) => error
    );
  } finally {
    controller.close();
  }
}

describe("editing a comment that RLS refuses, through TableController.update", () => {
  it("tells a grader the review was already released", async () => {
    const error = await editError();
    expect(getStudentFacingErrorMessage(error, { isStudent: false, releasedReviewGraderBlocked: true })).toBe(
      GRADING_FEEDBACK_RELEASED_GRADER_MESSAGE
    );
  });

  it("tells a student the self-review deadline has passed", async () => {
    const error = await editError();
    expect(getStudentFacingErrorMessage(error, { isStudent: true, rubricReviewRound: "self-review" })).toContain(
      "self-review due date has passed"
    );
  });

  it("without those contexts, says the change was refused, not that nothing was found", async () => {
    const error = await editError();
    const message = getUserFacingErrorMessage(error, { role: "grader" });
    expect(message).toBe("You don't have permission to change this, or it no longer exists. Nothing was changed.");
    expect(message).not.toBe(NOT_FOUND_MESSAGE);
  });
});

describe("a raw PGRST116, not from a TableController update", () => {
  // The mapper doesn't treat PGRST116 itself as a refusal: on a read, `.single()` finding no row (or
  // several) is not a permission problem, even on a screen that passes the released-review context.
  it("still means nothing was found, even with the released-review context", () => {
    expect(getUserFacingErrorMessage(PGRST116, { releasedReviewGraderBlocked: true })).toBe(NOT_FOUND_MESSAGE);
  });
});
