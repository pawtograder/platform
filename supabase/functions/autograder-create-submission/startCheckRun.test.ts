import { assertEquals, assertRejects } from "jsr:@std/assert";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { startCheckRun } from "./startCheckRun.ts";

function fixture(alwaysConflict = false) {
  let status: Record<string, unknown> = { queued: true };
  let reads = 0;
  let writes = 0;
  let triggered: string | null = "staff";
  const client = {
    from() {
      let update: { status: Record<string, unknown>; triggered_by?: null } | undefined;
      let expected: string;
      const query = {
        select() {
          if (!update) return query;
          writes++;
          if (writes === 1 || alwaysConflict) {
            status = {
              ...status,
              conclusion: "cancelled",
              workflow_run_id: 99,
              workflow_run_url: "https://forgejo/run/99"
            };
            return Promise.resolve({ data: [], error: null });
          }
          assertEquals(expected, JSON.stringify(status));
          status = update.status;
          if (update.triggered_by === null) triggered = null;
          return Promise.resolve({ data: [{ id: 1 }], error: null });
        },
        eq(key: string, value: string) {
          if (key === "status") expected = value;
          return query;
        },
        update(value: typeof update) {
          update = value;
          return query;
        },
        maybeSingle() {
          reads++;
          return Promise.resolve({ data: { status: { ...status } }, error: null });
        }
      };
      return query;
    }
  } as unknown as SupabaseClient<Database>;
  return { client, state: () => ({ status, reads, writes, triggered }) };
}
Deno.test("start retries with fresh terminal metadata and consumes manual trigger atomically", async () => {
  const f = fixture();
  await startCheckRun(f.client, 1, true);
  const s = f.state();
  assertEquals(s.reads, 2);
  assertEquals(s.status.conclusion, "cancelled");
  assertEquals(s.status.workflow_run_id, 99);
  assertEquals(s.status.workflow_run_url, "https://forgejo/run/99");
  assertEquals(typeof s.status.started_at, "string");
  assertEquals(s.triggered, null);
});
Deno.test("start retains trigger unless consumed and bounds conflicting retries", async () => {
  const f = fixture();
  await startCheckRun(f.client, 1, false);
  assertEquals(f.state().triggered, "staff");
  const conflict = fixture(true);
  await assertRejects(() => startCheckRun(conflict.client, 1, true), Error, "kept changing");
  assertEquals(conflict.state().reads, 5);
  assertEquals(conflict.state().triggered, "staff");
});
