/**
 * @jest-environment node
 *
 * (node, not jsdom: the fetch ingest reads real `Response` clones, which jsdom lacks. The tests
 * give the node global a `window` and `location` so the browser-only paths run.)
 *
 * The taint ingest (package 2): the fetch wrapper, the pre-start buffer, TableController
 * (`initialData`, `_addRow`, `_updateRow`, the start-up backfill), the auth session, and the rules
 * for unclassified and Json blob values.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

const SUPABASE = "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
const g = globalThis as unknown as { window: unknown; location: unknown; fetch: typeof fetch };
g.window = globalThis;
g.location = { href: "http://localhost:3000/course/1/gradebook", origin: "http://localhost:3000" };

/** Routes stubbed responses by URL substring. */
const routes: [string, () => Response][] = [];
function json(body: unknown, init: ResponseInit = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      ...init,
      headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) }
    });
}
g.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const route = routes.find(([part]) => url.includes(part));
  return route ? route[1]() : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
}) as typeof fetch;

// Imported after the globals exist: the fetch hook wraps `window.fetch` on install.
/* eslint-disable @typescript-eslint/no-require-imports */
const { installFetchHook } = require("@/lib/bugReport/fetchHook") as typeof import("@/lib/bugReport/fetchHook");
const gate = require("@/lib/bugReport/ingestGate") as typeof import("@/lib/bugReport/ingestGate");
const ingestModule = require("@/lib/bugReport/ingest") as typeof import("@/lib/bugReport/ingest");
const { getTaintSet } = require("@/lib/bugReport/taint") as typeof import("@/lib/bugReport/taint");
const TableController = (require("@/lib/TableController") as typeof import("@/lib/TableController")).default;
/* eslint-enable @typescript-eslint/no-require-imports */

installFetchHook();

function supabaseClient(): SupabaseClient<Database> {
  // Constructed after the hook, as utils/supabase/client.ts does, so it captures the wrapper.
  return createClient<Database>(SUPABASE, "anon", { auth: { persistSession: false, autoRefreshToken: false } });
}

const noSession = () => Promise.resolve(null);

afterEach(() => {
  routes.length = 0;
  gate.disarmIngest();
  getTaintSet().clear();
});

describe("value rules", () => {
  it("recognizes enum-like and structural strings", () => {
    expect(ingestModule.isEnumLike("open")).toBe(true);
    expect(ingestModule.isEnumLike("in_progress")).toBe(true);
    expect(ingestModule.isEnumLike("check-run")).toBe(true);
    expect(ingestModule.isEnumLike("Jane")).toBe(false);
    expect(ingestModule.isEnumLike("octocat42")).toBe(false);
    expect(ingestModule.isEnumLike("a_very_long_enum_value")).toBe(false);
    expect(ingestModule.isStructuralValue("6f1c2d3e-0000-4000-8000-000000000000")).toBe(true);
    expect(ingestModule.isStructuralValue("2026-09-29T12:00:00.123+00:00")).toBe(true);
    expect(ingestModule.isStructuralValue("87.31")).toBe(true);
    expect(ingestModule.isStructuralValue("Jane Doe")).toBe(false);
  });
});

describe("with no recorder", () => {
  it("leaves the sink null and adds nothing", async () => {
    routes.push(["/rest/v1/profiles", json([{ id: "p", name: "Zorvik Canary" }])]);
    expect(gate.bugReportIngest.sink).toBeNull();
    const { data } = await supabaseClient().from("profiles").select("id, name");
    expect(data).toHaveLength(1);
    expect(getTaintSet().size).toBe(0);
  });
});

describe("fetch ingest", () => {
  it("classifies an embed with an alias and FK hint without consuming the app's body (D2 shape)", async () => {
    routes.push([
      "/rest/v1/assignment_groups",
      json([{ id: 1, name: "team-zorvik", mentor: { name: "Mentor Quillon" } }])
    ]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      const { data } = await supabaseClient()
        .from("assignment_groups")
        .select("id, name, mentor:profiles!assignment_groups_mentor_profile_id_fkey(name)");
      expect(data?.[0].mentor).toEqual({ name: "Mentor Quillon" });
      await ingest.idle();
      const set = getTaintSet();
      expect(set.has("Mentor Quillon")).toBe(true);
      expect(set.has("Quillon, Mentor")).toBe(true);
      expect(set.has("team-zorvik")).toBe(true);
      expect(ingest.stats().responses).toBe(1);
    } finally {
      ingest.stop();
    }
  });

  it("classifies an RPC returning Json and skips grades (D6 shape)", async () => {
    routes.push([
      "/rest/v1/rpc/get_student_summary",
      json({ help_requests: [{ id: 1, request: "Help with the zorvik bug" }], assignments: [{ total_score: 87.31 }] })
    ]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await supabaseClient().rpc("get_student_summary" as never, {} as never);
      await ingest.idle();
      expect(getTaintSet().has("Help with the zorvik bug")).toBe(true);
      expect(getTaintSet().has("87.31")).toBe(false);
    } finally {
      ingest.stop();
    }
  });

  it("classifies an edge-function payload (D7 shape)", async () => {
    routes.push([
      "/functions/v1/repository-list-commits",
      json({ commits: [{ sha: "abc", author: { login: "zorvik-gh", id: 7 }, commit: { message: "m" } }] })
    ]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await supabaseClient().functions.invoke("repository-list-commits", { body: {} });
      await ingest.idle();
      expect(getTaintSet().has("zorvik-gh")).toBe(true);
    } finally {
      ingest.stop();
    }
  });

  it("taints every string of an unclassified key conservatively, except structural ones", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    routes.push([
      "/rest/v1/profiles",
      json([{ id: "p", name: "Zorvik Canary", brand_new_column: "Secret Thing", other: "2026-09-29" }])
    ]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await supabaseClient().from("profiles").select("*");
      await ingest.idle();
      expect(getTaintSet().has("Secret Thing")).toBe(true);
      expect(getTaintSet().has("2026-09-29")).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("profiles.brand_new_column"));
      // Keys only, never values.
      expect(warn.mock.calls.flat().join(" ")).not.toContain("Secret Thing");
      expect(ingest.stats().unclassifiedKeys).toBeGreaterThanOrEqual(1);
    } finally {
      ingest.stop();
      warn.mockRestore();
    }
  });

  it("skips enum-like strings inside a free_text Json column, but keeps names in it", async () => {
    routes.push([
      "/rest/v1/audit",
      json([{ id: 1, new: { status: "in_progress", state: "open", author: "Zorvik Canary", n: "octocat42" } }])
    ]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await supabaseClient().from("audit").select("id, new");
      await ingest.idle();
      const set = getTaintSet();
      expect(set.has("in_progress")).toBe(false);
      expect(set.has("open")).toBe(false);
      expect(set.has("Zorvik Canary")).toBe(true);
      expect(set.has("octocat42")).toBe(true);
    } finally {
      ingest.stop();
      warn.mockRestore();
    }
  });

  it("taints strings from /api/ routes and ignores non-JSON and other origins", async () => {
    routes.push(["/api/llm-hint", json({ hint: "Ask Quillon Zorvik" })]);
    routes.push([
      "/api/calendar",
      () => new Response("BEGIN:VCALENDAR Quillon", { headers: { "content-type": "text/calendar" } })
    ]);
    routes.push(["https://third.party/", json({ x: "Third Party Person" })]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await fetch("http://localhost:3000/api/llm-hint");
      await fetch("http://localhost:3000/api/calendar");
      await fetch("https://third.party/x");
      await ingest.idle();
      expect(getTaintSet().has("Ask Quillon Zorvik")).toBe(true);
      expect(getTaintSet().has("Third Party Person")).toBe(false);
      expect(ingest.stats().responses).toBe(1);
    } finally {
      ingest.stop();
    }
  });

  it("reads the user from auth responses", async () => {
    routes.push([
      "/auth/v1/user",
      json({
        id: "u",
        email: "self.canary@example.test",
        user_metadata: { full_name: "Self Canary", user_name: "self-gh", avatar_url: "https://avatars.example/u/9" }
      })
    ]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await fetch(`${SUPABASE}/auth/v1/user`);
      await ingest.idle();
      const set = getTaintSet();
      expect(set.has("self.canary@example.test")).toBe(true);
      expect(set.has("Canary, Self")).toBe(true);
      expect(set.has("self-gh")).toBe(true);
    } finally {
      ingest.stop();
    }
  });

  it("detaches on stop", async () => {
    routes.push(["/rest/v1/profiles", json([{ id: "p", name: "Zorvik Canary" }])]);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    ingest.stop();
    expect(gate.bugReportIngest.sink).toBeNull();
    await supabaseClient().from("profiles").select("id, name");
    expect(getTaintSet().size).toBe(0);
  });
});

describe("pre-start buffer", () => {
  it("keeps responses unread until the ingest starts, then classifies them", async () => {
    routes.push(["/rest/v1/profiles", json([{ id: "p", name: "Early Zorvik" }])]);
    gate.armIngest();
    expect(gate.isIngestArmed()).toBe(true);
    await supabaseClient().from("profiles").select("id, name");
    expect(getTaintSet().size).toBe(0);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      expect(gate.isIngestArmed()).toBe(false);
      await ingest.idle();
      expect(getTaintSet().has("Early Zorvik")).toBe(true);
    } finally {
      ingest.stop();
    }
  });

  it("drops them when disarmed (flag off)", async () => {
    routes.push(["/rest/v1/profiles", json([{ id: "p", name: "Early Zorvik" }])]);
    gate.armIngest();
    await supabaseClient().from("profiles").select("id, name");
    gate.disarmIngest();
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      await ingest.idle();
      expect(getTaintSet().has("Early Zorvik")).toBe(false);
    } finally {
      ingest.stop();
    }
  });

  it("skips URLs that can't carry classified data", () => {
    expect(gate.isIngestUrl(`${SUPABASE}/rest/v1/profiles?select=*`)).toBe(true);
    expect(gate.isIngestUrl(`${SUPABASE}/functions/v1/x`)).toBe(true);
    expect(gate.isIngestUrl(`${SUPABASE}/storage/v1/object/x`)).toBe(false);
    expect(gate.isIngestUrl("http://localhost:3000/api/tunnel")).toBe(false);
    expect(gate.isIngestUrl("http://localhost:3000/_next/static/chunk.js")).toBe(false);
    expect(gate.isIngestUrl("https://evil.example/rest/v1/profiles")).toBe(false);
  });
});

describe("auth session", () => {
  it("adds the reporter's own email and metadata at start (D16 shape)", async () => {
    const ingest = ingestModule.startIngest({
      getSessionUser: async () => ({
        email: "reporter.canary@example.test",
        user_metadata: { name: "Reporter Zorvik", preferred_username: "rep-gh", custom: "Some Nickname" },
        identities: [{ identity_data: { email: "rep.gh@example.test", user_name: "rep-gh2" } }]
      })
    });
    try {
      await ingest.idle();
      const set = getTaintSet();
      expect(set.has("reporter.canary@example.test")).toBe(true);
      expect(set.has("reporter.canary")).toBe(true);
      expect(set.has("Zorvik, Reporter")).toBe(true);
      expect(set.has("rep-gh")).toBe(true);
      expect(set.has("rep-gh2")).toBe(true);
      expect(set.has("rep.gh@example.test")).toBe(true);
      expect(set.has("Some Nickname")).toBe(true);
    } finally {
      ingest.stop();
    }
  });
});

describe("TableController ingest", () => {
  function controller(initialData?: Record<string, unknown>[]) {
    const client = supabaseClient();
    routes.push(["/rest/v1/profiles", json([])]);
    return new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: client.from("profiles").select("*").eq("class_id", 1) as any,
      client,
      table: "profiles",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialData: initialData as any
    });
  }

  it("ingests initialData while recording (D1 shape)", async () => {
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    const c = controller([{ id: "p1", name: "Roster Zorvik", sortable_name: "Zorvik, Roster" }]);
    try {
      await c.readyPromise;
      expect(getTaintSet().has("Roster Zorvik")).toBe(true);
    } finally {
      c.close();
      ingest.stop();
    }
  });

  it("backfills rows held by controllers created before the recorder started", async () => {
    const c = controller([{ id: "p1", name: "Hydrated Quillon" }]);
    await c.readyPromise;
    expect(getTaintSet().size).toBe(0);
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      expect(getTaintSet().has("Hydrated Quillon")).toBe(true);
    } finally {
      c.close();
      ingest.stop();
    }
  });

  it("does not backfill closed controllers", async () => {
    const c = controller([{ id: "p1", name: "Closed Quillon" }]);
    await c.readyPromise;
    c.close();
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      expect(getTaintSet().has("Closed Quillon")).toBe(false);
    } finally {
      ingest.stop();
    }
  });

  it("ingests _addRow and _updateRow", async () => {
    const c = controller([{ id: "p1", name: "Zorvik One" }]);
    await c.readyPromise;
    const ingest = ingestModule.startIngest({ getSessionUser: noSession });
    try {
      const internals = c as unknown as {
        _addRow(row: Record<string, unknown>): void;
        _updateRow(id: string, row: Record<string, unknown>): void;
      };
      internals._addRow({ id: "p2", name: "Added Zorvik", __db_pending: false });
      internals._updateRow("p1", { id: "p1", name: "Renamed Zorvik" });
      expect(getTaintSet().has("Added Zorvik")).toBe(true);
      expect(getTaintSet().has("Renamed Zorvik")).toBe(true);
    } finally {
      c.close();
      ingest.stop();
    }
  });
});
