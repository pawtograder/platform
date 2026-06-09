/**
 * Regression test for the "Object captured as exception with keys: message"
 * (PostgREST 400 Bad Request) production error.
 *
 * Root cause: PostgREST builders are NOT immutable. `.order()` / `.gt()` mutate
 * the builder's `url.searchParams` (appending), and the copy constructor
 * (`new PostgrestFilterBuilder(q)`) copies the `url` *reference*, not a clone.
 * TableController derived its per-refetch query straight from `this._query`, so
 * every refetch leaked another `order=id.asc` (and `updated_at=gt.…`) clause
 * back into the shared base query. During a realtime reconnect storm this grew
 * the query string without bound — `order=id.asc,id.asc,id.asc,…` — until
 * PostgREST rejected it with 400 Bad Request.
 *
 * The fix routes both refetch paths through `_freshQuery()`, which clones the
 * URL so the base query stays pristine. These tests assert that invariant.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController from "@/lib/TableController";
import type { Database } from "@/utils/supabase/SupabaseTypes";

// A fetch stub that always returns an empty result set so refetches complete
// without touching the network.
function emptyOkResponse(): Response {
  return new Response("[]", {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" }
  });
}

function makeController() {
  const fetchStub = jest.fn(async () => emptyOkResponse());
  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;

  // Real PostgREST builder — the same object type used in production.
  const baseQuery = client.from("profiles").select("*").eq("class_id", 1);

  const controller = new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: baseQuery as any,
    client,
    table: "profiles",
    // Skip the realtime wiring and initial fetch; we only exercise refetch.
    initialData: [],
    loadEntireTable: true
  });

  // Reading the protected `url` is intentional white-box access for this test.
  const baseUrl = () => (baseQuery as unknown as { url: URL }).url;
  return { controller, baseQuery, baseUrl, client };
}

describe("TableController does not accumulate query params on the base query", () => {
  it("_freshQuery() returns a builder with an independent URL", () => {
    const { controller, baseUrl } = makeController();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh = (controller as any)._freshQuery();
    fresh.order("id", { ascending: true }).gt("updated_at", "2020-01-01T00:00:00Z");

    // Mutating the derived query must NOT leak into the base query.
    expect(baseUrl().searchParams.getAll("order")).toEqual([]);
    expect(baseUrl().searchParams.getAll("updated_at")).toEqual([]);

    // A second clone is also pristine (proves clones are independent of each other).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh2 = (controller as any)._freshQuery();
    expect((fresh2 as unknown as { url: URL }).url.searchParams.getAll("order")).toEqual([]);

    controller.close();
  });

  it("repeated full refetches never grow the base query's order clause", async () => {
    const { controller, baseUrl } = makeController();

    // Drive the reconnect refetch path directly (no rate limit, unlike refetchAll).
    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (controller as any)._refetchAllData();
    }

    // Before the fix this would be ["id.asc,id.asc,...,id.asc"] (25 entries).
    expect(baseUrl().searchParams.getAll("order")).toEqual([]);

    controller.close();
  });

  it("repeated since-watermark refetches never accumulate gt(updated_at)/order filters", async () => {
    const { controller, baseUrl } = makeController();

    // Force the incremental (watermark) path: set a non-null max updated_at.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)._maxUpdatedAtMs = Date.parse("2026-01-01T00:00:00Z");

    for (let i = 0; i < 25; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (controller as any)._refetchSinceMaxUpdatedAt();
    }

    // Before the fix the base query accumulated one `updated_at=gt.…` and two
    // order columns (`updated_at`, `id`) per refetch.
    expect(baseUrl().searchParams.getAll("updated_at")).toEqual([]);
    expect(baseUrl().searchParams.getAll("order")).toEqual([]);

    controller.close();
  });
});
