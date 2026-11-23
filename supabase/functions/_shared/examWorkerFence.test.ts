/**
 * The exam worker's ownership boundary (#1158), driven by a fake client: each call goes to the SQL
 * function it names, with the claim, and its reply is mapped exactly; nothing falls back to an
 * unfenced write; readiness is "not deployed" only for a missing function or an older version.
 *
 * What the SQL does with these calls (a stale read_ct changes nothing; a requeue or give-up is one
 * transaction) is tested against Postgres in tests/e2e/exam-worker-batch-status-db.spec.ts, which
 * calls the functions through the same argument builders. The last test here checks those builders
 * against the parameter names in the migration, so a rename on either side fails here first.
 */

import { assert, assertEquals, assertInstanceOf, assertRejects } from "jsr:@std/assert@^1";
import {
  ack,
  ackArgs,
  contractStatus,
  CONTRACT_VERSION,
  FenceRpcError,
  giveUp,
  giveUpArgs,
  linkArgs,
  linkScanGroups,
  requeue,
  requeueArgs,
  setMatchSuggestion,
  suggestionArgs,
  type FenceClient
} from "./examWorkerFence.ts";

type Reply = { data: unknown; error: { code?: string; message: string } | null };
type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(replies: Record<string, Reply>) {
  const calls: Call[] = [];
  const client: FenceClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      const reply = replies[fn];
      if (!reply) throw new Error(`unexpected call to ${fn}`);
      return Promise.resolve(reply);
    }
  };
  return { client, calls };
}

const claim = { msgId: 41, readCt: 3 };
const ok = (data: unknown): Reply => ({ data, error: null });
const fail = (code: string, message = "boom"): Reply => ({ data: null, error: { code, message } });

Deno.test("contract: ready only at the version this worker needs", async () => {
  assertEquals(await contractStatus(fakeClient({ exam_worker_contract_version: ok(CONTRACT_VERSION) }).client), {
    ready: true
  });
  const older = await contractStatus(fakeClient({ exam_worker_contract_version: ok(CONTRACT_VERSION - 1) }).client);
  assertEquals(older.ready, false);
});

Deno.test("contract: a missing function means not deployed, not an error", async () => {
  const status = await contractStatus(fakeClient({ exam_worker_contract_version: fail("PGRST202") }).client);
  assertEquals(status.ready, false);
});

Deno.test("contract: any other error is thrown, so an outage is not read as a missing migration", async () => {
  await assertRejects(
    () => contractStatus(fakeClient({ exam_worker_contract_version: fail("PGRST301", "connection refused") }).client),
    FenceRpcError
  );
  await assertRejects(() => contractStatus(fakeClient({ exam_worker_contract_version: ok("1") }).client));
});

Deno.test("ack, requeue and give-up call their functions with the claim and map the reply", async () => {
  const fake = fakeClient({
    exam_worker_ack: ok("acked"),
    exam_worker_requeue: ok("not_owner"),
    exam_worker_give_up: ok("given_up:no_audit_row")
  });
  assertEquals(await ack(fake.client, claim), "acked");
  assertEquals(await requeue(fake.client, claim, { method: "match" }, 5, true), "not_owner");
  assertEquals(
    await giveUp(fake.client, claim, { batchId: 7, from: ["ocr"], error: "e", errorType: "Error", envelope: { a: 1 } }),
    "given_up:no_audit_row"
  );
  assertEquals(fake.calls, [
    { fn: "exam_worker_ack", args: { p_msg_id: 41, p_read_ct: 3 } },
    {
      fn: "exam_worker_requeue",
      args: { p_msg_id: 41, p_read_ct: 3, p_message: { method: "match" }, p_delay: 5, p_count_wait: true }
    },
    {
      fn: "exam_worker_give_up",
      args: {
        p_msg_id: 41,
        p_read_ct: 3,
        p_batch_id: 7,
        p_from: ["ocr"],
        p_error: "e",
        p_error_type: "Error",
        p_envelope: { a: 1 }
      }
    }
  ]);
});

Deno.test("match writes call their functions with the claim and map the reply", async () => {
  const fake = fakeClient({
    exam_worker_link_scan_groups: ok({ outcome: "applied", rows: [{ exam_index: 0 }] }),
    exam_worker_set_match_suggestion: ok("skipped")
  });
  assertEquals(await linkScanGroups(fake.client, claim, 7, [{ exam_index: 0, page_ids: [1, 2] }]), {
    outcome: "applied",
    rows: [{ exam_index: 0 }]
  });
  assertEquals(
    await setMatchSuggestion(fake.client, claim, 7, 9, {
      detectedName: "Ada",
      detectedSisId: null,
      matchedProfileId: null,
      confidence: 0,
      pageIds: [1, 2]
    }),
    "skipped"
  );
  assertEquals(fake.calls[1].args, {
    p_msg_id: 41,
    p_read_ct: 3,
    p_batch_id: 7,
    p_scanned_id: 9,
    p_detected_name: "Ada",
    p_detected_sis_id: null,
    p_matched_profile_id: null,
    p_match_confidence: 0,
    p_page_ids: [1, 2]
  });
  for (const outcome of ["not_owner", "state_changed"] as const) {
    const f = fakeClient({ exam_worker_link_scan_groups: ok({ outcome }) });
    assertEquals(await linkScanGroups(f.client, claim, 7, []), { outcome });
  }
});

Deno.test("no fallback: a missing function, or any error, is thrown with its code", async () => {
  for (const [fn, run] of [
    ["exam_worker_ack", (c: FenceClient) => ack(c, claim)],
    ["exam_worker_requeue", (c: FenceClient) => requeue(c, claim, {}, 5, false)],
    [
      "exam_worker_give_up",
      (c: FenceClient) => giveUp(c, claim, { batchId: null, from: [], error: "e", errorType: "E", envelope: null })
    ],
    ["exam_worker_link_scan_groups", (c: FenceClient) => linkScanGroups(c, claim, 7, [])],
    [
      "exam_worker_set_match_suggestion",
      (c: FenceClient) =>
        setMatchSuggestion(c, claim, 7, 9, {
          detectedName: null,
          detectedSisId: null,
          matchedProfileId: null,
          confidence: 0,
          pageIds: [1]
        })
    ]
  ] as const) {
    const fake = fakeClient({ [fn]: fail("PGRST202", "function not found") });
    const err = await assertRejects(() => run(fake.client));
    assertInstanceOf(err, FenceRpcError);
    assertEquals(err.code, "PGRST202");
    // Exactly the one call: nothing was written another way.
    assertEquals(
      fake.calls.map((c) => c.fn),
      [fn]
    );
  }
  const linkGuard = fakeClient({ exam_worker_link_scan_groups: fail("EX409", "would regroup a confirmed exam") });
  const err = await assertRejects(() => linkScanGroups(linkGuard.client, claim, 7, []));
  assertInstanceOf(err, FenceRpcError);
  assertEquals(err.code, "EX409");
});

Deno.test("an unexpected reply is an error, never read as success", async () => {
  await assertRejects(() => ack(fakeClient({ exam_worker_ack: ok(true) }).client, claim));
  await assertRejects(() => requeue(fakeClient({ exam_worker_requeue: ok(null) }).client, claim, {}, 5, false));
  await assertRejects(() => linkScanGroups(fakeClient({ exam_worker_link_scan_groups: ok([]) }).client, claim, 7, []));
});

Deno.test("every argument builder uses exactly the parameter names of its SQL function", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../migrations/20261122130000_pgmq_public_set_vt_if_claimed.sql", import.meta.url)
  );
  const params = (fn: string) => {
    const m = sql.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`));
    assert(m, `${fn} not found in the migration`);
    return m[1]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter((p) => p.length > 0)
      .sort();
  };
  const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
  assertEquals(keys(ackArgs(claim)), params("exam_worker_ack"));
  assertEquals(keys(requeueArgs(claim, {}, 5, false)), params("exam_worker_requeue"));
  assertEquals(
    keys(giveUpArgs(claim, { batchId: null, from: [], error: "", errorType: "", envelope: null })),
    params("exam_worker_give_up")
  );
  assertEquals(keys(linkArgs(claim, 7, [])), params("exam_worker_link_scan_groups"));
  assertEquals(
    keys(
      suggestionArgs(claim, 7, 9, {
        detectedName: null,
        detectedSisId: null,
        matchedProfileId: null,
        confidence: 0,
        pageIds: [1]
      })
    ),
    params("exam_worker_set_match_suggestion")
  );
});
