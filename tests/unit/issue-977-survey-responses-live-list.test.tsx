/**
 * Regression test for #977: an instructor on a survey's responses page saw a student's unfinished
 * draft as a response.
 *
 * The responses page lists what useSurveyResponses returns, and its Total Responses, Response Rate
 * and Export to CSV all count that list. The hook's query selects submitted, undeleted responses,
 * but the realtime filter that decides which broadcast rows join the live list only checked
 * survey_id. Once #977 made every survey autosave, a student typing an answer inserted a draft row,
 * the staff channel broadcast it, and the draft joined the list without a reload. A soft delete
 * arrives as an update, so a deleted response stayed listed the same way.
 *
 * These tests run the real hook and its TableController. The network is a fetch stub that answers
 * PostgREST requests from an in-memory table, and the realtime side is a stand-in class controller
 * that delivers broadcasts shaped like broadcast_survey_response_change()'s (full row in `data`),
 * or ID-only ones that make the controller fetch the row.
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import { useSurveyResponses } from "@/hooks/useCourseController";
import type { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import type { ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import type { BroadcastMessage } from "@/lib/TableController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type SurveyResponseRow = Database["public"]["Tables"]["survey_responses"]["Row"];

const CLASS_ID = 1;
const SURVEY_ID = "survey-977";
const OTHER_SURVEY_ID = "survey-other";

/** Rows the fake PostgREST serves, keyed by id. */
let table: Map<string, SurveyResponseRow>;
let courseController: unknown;
let realtime: ReturnType<typeof makeFakeRealTimeController>;

function makeRow(overrides: Partial<SurveyResponseRow> & Pick<SurveyResponseRow, "id" | "profile_id">) {
  const row: SurveyResponseRow = {
    survey_id: SURVEY_ID,
    is_submitted: false,
    submitted_at: null,
    deleted_at: null,
    response: {},
    created_at: "2026-11-02T12:00:00.000Z",
    updated_at: "2026-11-02T12:00:00.000Z",
    ...overrides
  };
  return row;
}

/** Applies the PostgREST filters this hook and TableController send: eq, is.null and in. */
function matchesPostgrestFilters(row: SurveyResponseRow, params: URLSearchParams): boolean {
  for (const [column, filter] of params) {
    if (["select", "order", "limit", "offset"].includes(column)) continue;
    const value = (row as Record<string, unknown>)[column];
    if (filter.startsWith("eq.")) {
      if (String(value) !== filter.slice(3)) return false;
    } else if (filter === "is.null") {
      if (value !== null) return false;
    } else if (filter.startsWith("in.(")) {
      const allowed = filter
        .slice(4, -1)
        .split(",")
        .map((v) => v.replace(/^"|"$/g, ""));
      if (!allowed.includes(String(value))) return false;
    } else {
      throw new Error(`fake PostgREST does not handle ${column}=${filter}`);
    }
  }
  return true;
}

function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => text,
    json: async () => body
  };
}

function makeClient(): SupabaseClient<Database> {
  const fetchStub = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/rest/v1/survey_responses")) {
      throw new Error(`unexpected request ${url.pathname}`);
    }
    const rows = [...table.values()].filter((row) => matchesPostgrestFilters(row, url.searchParams));
    return jsonResponse(rows);
  };
  return createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;
}

/** Stands in for ClassRealTimeController: hands the test the staff channel's survey_responses handler. */
function makeFakeRealTimeController() {
  const handlers: ((message: BroadcastMessage) => void)[] = [];
  const fake = {
    isClosed: false,
    subscribeToTable(tableName: string, handler: (message: BroadcastMessage) => void) {
      if (tableName === "survey_responses") handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
    subscribeToStatus() {
      return () => {};
    },
    getConnectionStatus(): ConnectionStatus {
      return { overall: "connected", channels: [], lastUpdate: new Date() };
    },
    get subscribed() {
      return handlers.length > 0;
    },
    /** What broadcast_survey_response_change() sends for a row: the whole row in `data`. */
    broadcast(operation: "INSERT" | "UPDATE" | "DELETE", row: SurveyResponseRow) {
      const message: BroadcastMessage = {
        type: "table_change",
        table: "survey_responses",
        operation,
        row_id: row.id,
        class_id: CLASS_ID,
        data: row as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString()
      };
      handlers.forEach((handler) => handler(message));
    },
    /** A broadcast that names the row without its data, so the controller fetches it. */
    broadcastIdOnly(operation: "INSERT" | "UPDATE", id: string) {
      const message: BroadcastMessage = {
        type: "table_change",
        table: "survey_responses",
        operation,
        row_id: id,
        class_id: CLASS_ID,
        timestamp: new Date().toISOString()
      };
      handlers.forEach((handler) => handler(message));
    }
  };
  return fake;
}

/** The database write and its broadcast, as the trigger pairs them. */
function write(operation: "INSERT" | "UPDATE", row: SurveyResponseRow) {
  table.set(row.id, row);
  realtime.broadcast(operation, row);
}

async function renderResponsesList() {
  const hook = renderHook(() => useSurveyResponses(SURVEY_ID));
  await waitFor(() => {
    expect(hook.result.current.isLoading).toBe(false);
    expect(realtime.subscribed).toBe(true);
  });
  return hook;
}

const listedIds = (hook: Awaited<ReturnType<typeof renderResponsesList>>) =>
  hook.result.current.responses.map((r) => r.id).sort();

// Broadcasts are debounced (500 ms plus up to 500 ms of jitter) before the list changes.
const LIVE_UPDATE = { timeout: 5000 };

// A classmate who completes the survey after the event under test. Batches are applied in the
// order they arrived, so once this row is listed, everything broadcast before it has been handled.
const classmateSubmits = () =>
  write(
    "INSERT",
    makeRow({
      id: "resp-classmate",
      profile_id: "student-classmate",
      is_submitted: true,
      submitted_at: "2026-11-02T12:05:00.000Z",
      response: { q1: "Done" }
    })
  );

// One client for the file: the fetch stub reads whatever `table` holds when a request is made.
const client = makeClient();

beforeEach(() => {
  table = new Map();
  realtime = makeFakeRealTimeController();
  courseController = {
    client,
    classRealTimeController: realtime as unknown as ClassRealTimeController,
    profiles: {
      list: () => ({
        data: [
          { id: "student-a", name: "Student A" },
          { id: "student-classmate", name: "Classmate" }
        ],
        unsubscribe: () => {}
      })
    }
  };
  // CourseControllerContext is private to hooks/useCourseController.tsx, and its provider starts a
  // live ClassRealTimeController. With no provider mounted, hand the hook the course controller above.
  const realUseContext = React.useContext;
  jest
    .spyOn(React, "useContext")
    .mockImplementation(
      ((context: React.Context<unknown>) => realUseContext(context) ?? courseController) as typeof React.useContext
    );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("issue #977: the instructor's live survey responses list", () => {
  test("a draft the student is still typing is not listed", async () => {
    const hook = await renderResponsesList();

    const draft = makeRow({ id: "resp-a", profile_id: "student-a", response: { q1: "Half an ans" } });
    write("INSERT", draft);
    write("UPDATE", { ...draft, response: { q1: "Half an answer" }, updated_at: "2026-11-02T12:01:00.000Z" });
    classmateSubmits();

    await waitFor(() => expect(listedIds(hook)).toContain("resp-classmate"), LIVE_UPDATE);
    expect(listedIds(hook)).toEqual(["resp-classmate"]);
    hook.unmount();
  });

  test("the response is listed live once the student completes the survey", async () => {
    const hook = await renderResponsesList();

    const draft = makeRow({ id: "resp-a", profile_id: "student-a", response: { q1: "Half an answer" } });
    write("INSERT", draft);
    write("UPDATE", {
      ...draft,
      is_submitted: true,
      submitted_at: "2026-11-02T12:02:00.000Z",
      response: { q1: "Full answer" },
      updated_at: "2026-11-02T12:02:00.000Z"
    });

    await waitFor(() => expect(listedIds(hook)).toEqual(["resp-a"]), LIVE_UPDATE);
    const [listed] = hook.result.current.responses;
    expect(listed.submitted_at).toBe("2026-11-02T12:02:00.000Z");
    expect(listed.response).toEqual({ q1: "Full answer" });
    expect(listed.profiles?.name).toBe("Student A");
    hook.unmount();
  });

  test("a submitted response leaves the list when it is deleted", async () => {
    const submitted = makeRow({
      id: "resp-a",
      profile_id: "student-a",
      is_submitted: true,
      submitted_at: "2026-11-02T12:02:00.000Z",
      response: { q1: "Full answer" }
    });
    table.set(submitted.id, submitted);
    const hook = await renderResponsesList();
    expect(listedIds(hook)).toEqual(["resp-a"]);

    write("UPDATE", { ...submitted, deleted_at: "2026-11-02T12:10:00.000Z", updated_at: "2026-11-02T12:10:00.000Z" });
    classmateSubmits();

    await waitFor(() => expect(listedIds(hook)).toContain("resp-classmate"), LIVE_UPDATE);
    expect(listedIds(hook)).toEqual(["resp-classmate"]);
    hook.unmount();
  });

  test("a response to another survey is not listed", async () => {
    const hook = await renderResponsesList();

    write(
      "INSERT",
      makeRow({
        id: "resp-other-survey",
        profile_id: "student-a",
        survey_id: OTHER_SURVEY_ID,
        is_submitted: true,
        submitted_at: "2026-11-02T12:02:00.000Z"
      })
    );
    classmateSubmits();

    await waitFor(() => expect(listedIds(hook)).toContain("resp-classmate"), LIVE_UPDATE);
    expect(listedIds(hook)).toEqual(["resp-classmate"]);
    hook.unmount();
  });

  test("a broadcast without row data gets the same check after the row is fetched", async () => {
    const hook = await renderResponsesList();

    const draft = makeRow({ id: "resp-a", profile_id: "student-a", response: { q1: "Half an answer" } });
    table.set(draft.id, draft);
    realtime.broadcastIdOnly("INSERT", draft.id);
    classmateSubmits();

    await waitFor(() => expect(listedIds(hook)).toContain("resp-classmate"), LIVE_UPDATE);
    expect(listedIds(hook)).toEqual(["resp-classmate"]);

    table.set(draft.id, {
      ...draft,
      is_submitted: true,
      submitted_at: "2026-11-02T12:02:00.000Z",
      response: { q1: "Full answer" },
      updated_at: "2026-11-02T12:02:00.000Z"
    });
    realtime.broadcastIdOnly("UPDATE", draft.id);

    await waitFor(() => expect(listedIds(hook)).toEqual(["resp-a", "resp-classmate"]), LIVE_UPDATE);
    hook.unmount();
  });
});
