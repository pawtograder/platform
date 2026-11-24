/** @jest-environment node */
import { createClient } from "@supabase/supabase-js";
import TableController from "@/lib/TableController";
import type { Database } from "@/supabase/functions/_shared/SupabaseTypes";

jest.mock("@/lib/bugReport/ingestGate", () => ({
  bugReportIngest: {},
  registerRowSource: jest.fn(),
  unregisterRowSource: jest.fn()
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));

for (const naturalKey of [false, true]) {
  describe(naturalKey ? "natural-key refetch" : "id refetch", () => {
    for (const method of ["invalidate", "refetchByIds"] as const) {
      test(`${method} removes a missing row, preserves unrelated rows, and retains data on failure`, async () => {
        const initialRows = naturalKey
          ? [
              { role_id: 7, capability: "a" },
              { role_id: 7, capability: "b" }
            ]
          : [
              { id: 7, name: "a" },
              { id: 8, name: "b" }
            ];
        let result = initialRows;
        let fail = false;
        const requests: URL[] = [];
        const client = createClient<Database>("http://localhost:54321", "test", {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: async (input) => {
              requests.push(new URL(String(input)));
              return new Response(JSON.stringify(fail ? { message: "Unavailable" } : result), {
                status: fail ? 503 : 200
              });
            }
          }
        });
        const controller = naturalKey
          ? new TableController<"role_capabilities", "*", string | number>({
              client,
              table: "role_capabilities",
              keyColumns: ["role_id", "capability"],
              query: client.from("role_capabilities").select("*")
            })
          : new TableController<"class_roles", "*", string | number>({
              client,
              table: "class_roles",
              query: client.from("class_roles").select("*")
            });
        const key = naturalKey ? JSON.stringify([7, "a"]) : 7;
        const refresh = () => (method === "invalidate" ? controller.invalidate(key) : controller.refetchByIds([key]));
        try {
          await controller.readyPromise;
          const listener = jest.fn();
          controller.list(listener);
          fail = true;
          if (method === "invalidate" || naturalKey)
            await expect(refresh()).rejects.toMatchObject({ message: "Unavailable" });
          else await refresh();
          expect(controller.rowCount).toBe(2);
          fail = false;
          result = [];
          await refresh();
          expect(controller.rows).toHaveLength(1);
          expect(controller.rows[0]).toMatchObject(initialRows[1]);
          expect(listener).toHaveBeenLastCalledWith(
            expect.any(Array),
            expect.objectContaining({ left: [expect.objectContaining(initialRows[0])] })
          );
          const request = requests.at(-1)!;
          expect(request.searchParams.get(naturalKey ? "role_id" : "id")).toBe(
            naturalKey ? "eq.7" : method === "invalidate" ? "eq.7" : "in.(7)"
          );
          if (naturalKey) expect(request.searchParams.get("capability")).toBe("eq.a");
        } finally {
          controller.close();
        }
      });
    }
  });
}
