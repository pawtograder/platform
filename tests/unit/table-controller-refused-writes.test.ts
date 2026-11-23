/**
 * @jest-environment node
 *
 * TableController reports writes that RLS refused (#983, Jon's review on #1159).
 *
 * RLS doesn't fail an UPDATE or DELETE it refuses: the statement matches 0 rows and PostgREST
 * answers without an error. TableController used to treat that as success:
 * - `update` ends in `.select("*").single()`, so a refusal came back as the raw PGRST116 error
 *   ("JSON object requested, multiple (or no) rows returned").
 * - `delete` (soft) and `hardDelete` asked for nothing back, so a refusal was silent and the row
 *   vanished from the UI until the next refetch.
 * They now throw the same refusedWriteError as the refine data provider.
 *
 * These tests stub PostgREST's responses. tests/e2e/table-controller-refused-writes.spec.ts runs
 * the same cases against real RLS as a grader.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

import TableController from "@/lib/TableController";
import { isRefusedWriteError } from "@/lib/refusedWriteError";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type Row = { id: number; comment: string; deleted_at: string | null };
type Handler = (url: URL, init: RequestInit) => Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

/** PostgREST's answer to a write sent with `Prefer: count=exact` and no `select`. */
function changed(count: number): Response {
  return new Response(null, { status: 204, headers: { "Content-Range": `*/${count}` } });
}

const PGRST116 = {
  code: "PGRST116",
  details: "The result contains 0 rows",
  hint: null,
  message: "JSON object requested, multiple (or no) rows returned"
};

function makeController(handlers: Partial<Record<"GET" | "PATCH" | "DELETE", Handler>>) {
  const requests: { method: string; url: URL; headers: Headers }[] = [];
  const fetchStub = jest.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input.toString());
    const method = (init.method ?? "GET") as "GET" | "PATCH" | "DELETE";
    requests.push({ method, url, headers: new Headers(init.headers) });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected ${method} ${url}`);
    return handler(url, init);
  });
  const client = createClient<Database>("http://localhost:54321", "test-anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchStub as unknown as typeof fetch }
  }) as SupabaseClient<Database>;

  const row: Row = { id: 7, comment: "original", deleted_at: null };
  const controller = new TableController({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: client.from("submission_comments").select("*").eq("class_id", 1) as any,
    client,
    table: "submission_comments",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialData: [row] as any,
    loadEntireTable: true
  });
  const cached = () => (controller.rows as unknown as Row[]).find((r) => r.id === 7);
  return { controller, requests, cached };
}

afterEach(() => jest.restoreAllMocks());

describe("TableController.update", () => {
  it("throws a refusedWriteError and rolls back when the update changed 0 rows (PGRST116)", async () => {
    const { controller, cached } = makeController({ PATCH: () => json(PGRST116, 406) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await controller.update(7, { comment: "edited" } as any).catch((e: unknown) => e);

    expect(isRefusedWriteError(error)).toBe(true);
    expect((error as Error).message).toBe(
      "You don't have permission to change this, or it no longer exists. Nothing was changed."
    );
    expect(cached()?.comment).toBe("original");
    controller.close();
  });

  it("passes other PostgREST errors through unchanged", async () => {
    const rls = { code: "42501", details: null, hint: null, message: "permission denied for table x" };
    const { controller, cached } = makeController({ PATCH: () => json(rls, 403) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await controller.update(7, { comment: "edited" } as any).catch((e: unknown) => e);

    expect(isRefusedWriteError(error)).toBe(false);
    expect(error).toMatchObject({ code: "42501", message: "permission denied for table x" });
    expect(cached()?.comment).toBe("original");
    controller.close();
  });

  it("returns the updated row when the update went through", async () => {
    const updated = { id: 7, comment: "edited", deleted_at: null };
    const { controller, cached } = makeController({ PATCH: () => json(updated) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(controller.update(7, { comment: "edited" } as any)).resolves.toEqual(updated);
    expect(cached()?.comment).toBe("edited");
    controller.close();
  });
});

describe.each([
  ["hardDelete", "DELETE"],
  ["delete", "PATCH"]
] as const)("TableController.%s", (method, httpMethod) => {
  it("resolves without a follow-up select when the row was changed", async () => {
    const { controller, requests, cached } = makeController({ [httpMethod]: () => changed(1) });

    await expect(controller[method](7)).resolves.toBeUndefined();

    expect(cached()).toBeUndefined();
    expect(requests.map((r) => r.method)).toEqual([httpMethod]);
    controller.close();
  });

  it("throws a refusedWriteError and restores the row when 0 rows changed and the row is still visible", async () => {
    const { controller, requests, cached } = makeController({
      [httpMethod]: () => changed(0),
      GET: () => json([{ id: 7 }])
    });

    const error = await controller[method](7).catch((e: unknown) => e);

    expect(isRefusedWriteError(error)).toBe(true);
    expect((error as Error).message).toBe("You don't have permission to delete this. Nothing was changed.");
    expect(cached()).toEqual({ id: 7, comment: "original", deleted_at: null, __db_pending: false });
    const [write, check] = requests;
    expect(write.headers.get("Prefer")).toContain("count=exact");
    expect(check.url.searchParams.get("select")).toBe("id");
    expect(check.url.searchParams.get("id")).toBe("eq.7");
    controller.close();
  });

  it("keeps a newer row that a realtime UPDATE put back during the follow-up select", async () => {
    // The UPDATE broadcast lands while the visibility select is in flight, so the cache already
    // holds the newer row when the refusal is detected. Restoring the pre-delete snapshot would
    // overwrite it (#1296 review).
    const ref: { controller?: unknown } = {};
    const { controller, cached } = makeController({
      [httpMethod]: () => changed(0),
      GET: () => {
        (ref.controller as { _handleUpdate(message: unknown): void })._handleUpdate({
          type: "table_change",
          operation: "UPDATE",
          table: "submission_comments",
          row_id: 7,
          data: { id: 7, comment: "newer", deleted_at: null }
        });
        return json([{ id: 7 }]);
      }
    });
    ref.controller = controller;

    const error = await controller[method](7).catch((e: unknown) => e);

    expect(isRefusedWriteError(error)).toBe(true);
    expect(cached()).toMatchObject({ id: 7, comment: "newer" });
    expect((controller.rows as unknown as Row[]).filter((r) => r.id === 7)).toHaveLength(1);
    controller.close();
  });

  it("resolves when 0 rows changed because the row is already gone", async () => {
    const { controller, cached } = makeController({
      [httpMethod]: () => changed(0),
      GET: () => json([])
    });

    await expect(controller[method](7)).resolves.toBeUndefined();
    expect(cached()).toBeUndefined();
    controller.close();
  });

  it("restores the row and rethrows when the follow-up select fails", async () => {
    const boom = { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" };
    const { controller, cached } = makeController({
      [httpMethod]: () => changed(0),
      GET: () => json(boom, 500)
    });

    const error = await controller[method](7).catch((e: unknown) => e);

    expect(isRefusedWriteError(error)).toBe(false);
    expect(error).toMatchObject({ code: "57014" });
    expect(cached()?.id).toBe(7);
    controller.close();
  });

  it("asks only for the changed-row count, not the rows", async () => {
    const { controller, requests } = makeController({ [httpMethod]: () => changed(1) });

    await controller[method](7);

    expect(requests[0].url.searchParams.has("select")).toBe(false);
    expect(requests[0].headers.get("Prefer") ?? "").not.toContain("return=representation");
    controller.close();
  });
});
