/**
 * #1158: exam-async-worker changes a batch's status only from the states its message belongs to,
 * and only through exam_worker_set_batch_status, which also checks that the worker still holds the
 * message (the database half is tests/e2e/exam-worker-batch-status-db.spec.ts).
 *
 * The table is the contract: a stale or taken-over message must not move a batch backwards
 * (completed -> matching -> review), complete a batch Retry reopened, or error a batch that has
 * moved past that message's phase. The source check keeps a new direct write from bypassing it.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  COMPLETED_FROM,
  errorFrom,
  MATCHING_FROM,
  REJECTED_SCAN_ERROR_FROM,
  REVIEW_FROM,
  type BatchStatus
} from "../../supabase/functions/exam-async-worker/batchTransitions";
import { MAX_OCR_WAITS, nextOcrWait, OCR_WAIT_COUNT_MS } from "../../supabase/functions/exam-async-worker/ocrWait";
import * as cw from "../../supabase/functions/exam-async-worker/claimWindow";

const ALL: BatchStatus[] = ["uploaded", "ocr", "matching", "review", "finalizing", "completed", "error"];
const WORKER = join(__dirname, "..", "..", "supabase", "functions", "exam-async-worker", "index.ts");

describe("issue #1158: worker batch status transitions", () => {
  test("match moves a batch only while it is before review", () => {
    expect([...MATCHING_FROM].sort()).toEqual(["matching", "ocr", "uploaded"]);
    expect([...REVIEW_FROM].sort()).toEqual(["matching", "ocr", "uploaded"]);
    for (const later of ["review", "finalizing", "completed", "error"] as BatchStatus[]) {
      expect(MATCHING_FROM).not.toContain(later);
      expect(REVIEW_FROM).not.toContain(later);
    }
  });

  test("finalize completes only a batch that is creating submissions", () => {
    expect(COMPLETED_FROM).toEqual(["finalizing"]);
  });

  test.each([
    ["process_page", ["ocr"]],
    ["match", ["matching", "ocr"]],
    ["finalize", ["finalizing"]],
    ["something_new", ["finalizing", "matching", "ocr"]],
    [undefined, ["finalizing", "matching", "ocr"]],
    // A malformed method that names an inherited Object property still gets the unknown-method list,
    // not the inherited function (which made setBatchStatus throw and kept the message from the DLQ).
    ["constructor", ["finalizing", "matching", "ocr"]],
    ["toString", ["finalizing", "matching", "ocr"]],
    ["__proto__", ["finalizing", "matching", "ocr"]],
    ["hasOwnProperty", ["finalizing", "matching", "ocr"]]
  ])("a %s message that exhausted its retries errors the batch only from %j", (method, expected) => {
    expect([...errorFrom(method)].sort()).toEqual(expected);
  });

  test("no message can error a completed, reviewed or already errored batch", () => {
    for (const method of ["process_page", "match", "finalize", undefined]) {
      for (const settled of ["completed", "review", "error", "uploaded"] as BatchStatus[]) {
        expect(errorFrom(method)).not.toContain(settled);
      }
    }
    expect(ALL).toEqual(expect.arrayContaining([...errorFrom(undefined)]));
  });

  test("a rejected scan errors its batch from any phase except completed (#1078)", () => {
    expect([...REJECTED_SCAN_ERROR_FROM].sort()).toEqual(ALL.filter((s) => s !== "completed").sort());
  });

  describe("the worker writes batch status only through setBatchStatus", () => {
    const source = readFileSync(WORKER, "utf8");
    const helperStart = source.indexOf("async function setBatchStatus(");
    const helperEnd = source.indexOf("\n}\n", helperStart);

    test("setBatchStatus calls exam_worker_set_batch_status with the message's claim", () => {
      expect(helperStart).toBeGreaterThan(-1);
      const helper = source.slice(helperStart, helperEnd);
      expect(helper).toContain('admin.rpc("exam_worker_set_batch_status"');
      expect(helper).toMatch(/p_msg_id: fence\.msgId/);
      expect(helper).toMatch(/p_read_ct: fence\.readCt/);
    });

    test("no other code updates exam_scan_batches", () => {
      const outside = source.slice(0, helperStart) + source.slice(helperEnd);
      expect(outside).not.toMatch(/from\("exam_scan_batches"\)\s*\.update\(/);
    });

    test("each status write passes its table", () => {
      expect(source).toMatch(/setBatchStatus\(admin, fence, batch\.id, "matching", MATCHING_FROM\)/);
      expect(source.match(/setBatchStatus\(admin, fence, batch\.id, "review", REVIEW_FROM\)/g)).toHaveLength(2);
      expect(source).toMatch(/setBatchStatus\(admin, fence, batchId, "completed", COMPLETED_FROM\)/);
      expect(source).toMatch(/setBatchStatus\(admin, fence, batchId, "error", from, message\)/);
      expect(source).toMatch(
        /const giveUp = async \(error: unknown, from: readonly BatchStatus\[\] = errorFrom\(env\.method\)\)/
      );
      expect(source).toMatch(/await giveUp\(error, REJECTED_SCAN_ERROR_FROM\)/);
    });
  });

  // Aryan's question on #1308, and Jon's and CodeRabbit's counterexample: with a reader reaching the
  // message every 25s, the old rule (a 30s re-queue delay, error on the 31st read) waits 25 minutes,
  // so "30 waits and 15 minutes" with 5s waits errored 10 minutes sooner. nextOcrWait counts a wait
  // only 30s after the last counted one, which is never sooner than the old rule.
  describe("match gives up on OCR no sooner than before #1158", () => {
    const S = 1000;
    const MIN = 60 * S;

    test.each([
      // waits, countedMs, nowMs -> result
      [0, undefined, 0, { exhausted: false, waits: 1, countedMs: 0 }], // the first wait counts
      [5, 100 * S, 120 * S, { exhausted: false, waits: 5, countedMs: 100 * S }], // too soon: not counted
      [5, 100 * S, 130 * S, { exhausted: false, waits: 6, countedMs: 130 * S }], // 30s on: counted
      [29, 0, 30 * S, { exhausted: false, waits: 30, countedMs: 30 * S }],
      [30, 0, 29 * S, { exhausted: false, waits: 30, countedMs: 0 }], // limit reached, but too soon
      [30, 0, 30 * S, { exhausted: true }],
      [30, undefined, 0, { exhausted: true }] // a message queued by the old worker, already at 30
    ])("nextOcrWait(%p, %p, %p)", (waits, countedMs, nowMs, expected) => {
      expect(nextOcrWait(waits, countedMs, nowMs)).toEqual(expected);
    });

    // When the batch errors, given when readers reach the waiting message. `firstReadAt(t)` is the
    // first moment at or after t that a reader takes the message if it is visible.
    type Readers = (t: number) => number;
    const every =
      (gap: number): Readers =>
      (t) =>
        Math.ceil(t / gap) * gap;
    const irregular = (seed: number): Readers => {
      const times: number[] = [0];
      let x = seed;
      while (times[times.length - 1] < 4 * 60 * MIN) {
        x = (x * 1103515245 + 12345) % 2147483648;
        times.push(times[times.length - 1] + 1 * S + (x % (90 * S)));
      }
      return (t) => times.find((r) => r >= t)!;
    };
    /** Before #1158: re-queued with a 30s delay; the read that finds 30 waits errors. */
    const stagingErrorsAt = (firstReadAt: Readers) => {
      let t = firstReadAt(0);
      for (let waits = 0; waits < MAX_OCR_WAITS; waits++) t = firstReadAt(t + 30 * S);
      return t;
    };
    /** Now: re-queued with a 5s delay, counted by nextOcrWait. */
    const nowErrorsAt = (firstReadAt: Readers) => {
      let t = firstReadAt(0);
      let waits = 0;
      let countedMs: number | undefined;
      for (let reads = 0; reads < 10_000; reads++) {
        const step = nextOcrWait(waits, countedMs, t);
        if (step.exhausted) return t;
        ({ waits, countedMs } = step);
        t = firstReadAt(t + 5 * S);
      }
      throw new Error("never gave up");
    };
    /** The rule this replaces: 5s waits, error once 30 waits AND 15 minutes have passed. */
    const previousErrorsAt = (firstReadAt: Readers) => {
      let t = firstReadAt(0);
      for (let waits = 0; ; waits++) {
        if (waits >= 30 && t >= 15 * MIN) return t;
        t = firstReadAt(t + 5 * S);
      }
    };

    test.each([
      ["idle readers (every 1s)", every(1 * S)],
      ["every 5s", every(5 * S)],
      ["every 25s (the review's case)", every(25 * S)],
      ["every 31s", every(31 * S)],
      ["every 45s", every(45 * S)],
      ["every 60s (cron only)", every(60 * S)],
      ["irregular, seed 1", irregular(1)],
      ["irregular, seed 42", irregular(42)]
    ])("%s: never sooner than before #1158", (_name, readers) => {
      expect(nowErrorsAt(readers)).toBeGreaterThanOrEqual(stagingErrorsAt(readers));
    });

    test("the review's case: the previous rule erred at 15 minutes, now it waits the old 25", () => {
      const readers = every(25 * S);
      expect(stagingErrorsAt(readers)).toBe(25 * MIN);
      expect(previousErrorsAt(readers)).toBe(15 * MIN);
      expect(nowErrorsAt(readers)).toBeGreaterThanOrEqual(25 * MIN);
    });

    test("with idle readers it still gives up in about 15 minutes, not later than 18", () => {
      expect(nowErrorsAt(every(1 * S))).toBeLessThanOrEqual(18 * MIN);
      expect(nowErrorsAt(every(1 * S))).toBeGreaterThanOrEqual(15 * MIN);
    });

    test("the limits are the old count and delay, and doMatch uses them", () => {
      expect(MAX_OCR_WAITS).toBe(30);
      expect(OCR_WAIT_COUNT_MS).toBe(30 * S);
      const source = readFileSync(WORKER, "utf8");
      expect(source).toMatch(/const step = nextOcrWait\(env\.ocr_waits \?\? 0, env\.ocr_wait_counted_ms, now\);/);
      expect(source).toMatch(/if \(step\.exhausted\) \{/);
      expect(source).not.toMatch(/ocrWaitExhausted/);
    });
  });

  // CodeRabbit on #1308: a late OCR result could replace OCR match had already read. The behavior is
  // tested against the running worker in exam-worker-batch-status-db.spec.ts; this keeps the filter.
  test("process_page writes OCR only to a page that has none", () => {
    const source = readFileSync(WORKER, "utf8");
    expect(source).toMatch(
      /\.update\(\{ ocr_text: result\.text, ocr_data:[^}]*\}[^)]*\)\s*\.eq\("id", args\.scan_page_id\)\s*\.eq\("batch_id", batchId\)\s*\.is\("ocr_data", null\);/
    );
  });
});

describe("claimWindow: when an invocation stops claiming (#1158)", () => {
  const S = 1000;

  test.each([
    ["chart default", 400 * S],
    ["production", 480 * S]
  ])("%s: a young isolate claims until a claimed message keeps its read window plus margin", (_n, lifetime) => {
    const deadline = cw.claimDeadlineMs(0, 5 * S, lifetime);
    expect(lifetime - deadline).toBe(cw.MESSAGE_RESERVE_MS + cw.CLAIM_MARGIN_MS);
    // Longer than the previous fixed 60s, which is where the backlog throughput comes back from.
    expect(deadline - 5 * S).toBeGreaterThan(cw.MIN_CLAIM_WINDOW_MS);
  });

  test.each([
    ["chart default", 400 * S],
    ["production", 480 * S]
  ])(
    "%s: an invocation that arrives as the isolate retires (half its lifetime) still leaves its last message room",
    (_n, lifetime) => {
      const start = lifetime / 2;
      const deadline = cw.claimDeadlineMs(0, start, lifetime);
      expect(deadline).toBeGreaterThanOrEqual(start + cw.MIN_CLAIM_WINDOW_MS);
      // What is left for the last claimed message: the read window plus margin, or the previous
      // rule's LIFETIME/2 - 60s when that is smaller (140s at 400s; 150s at 480s, 180s before).
      expect(lifetime - deadline).toBe(
        Math.min(cw.MESSAGE_RESERVE_MS + cw.CLAIM_MARGIN_MS, lifetime / 2 - cw.MIN_CLAIM_WINDOW_MS)
      );
    }
  );

  test("a lifetime too short for the reserve falls back to the 60s rule instead of claiming nothing", () => {
    expect(cw.claimDeadlineMs(0, 0, 100 * S)).toBe(cw.MIN_CLAIM_WINDOW_MS);
  });

  test("never earlier than 60s after the invocation starts, whatever the isolate's age", () => {
    for (const start of [0, 100 * S, 250 * S, 390 * S, 1000 * S]) {
      expect(cw.claimDeadlineMs(0, start, 400 * S)).toBeGreaterThanOrEqual(start + cw.MIN_CLAIM_WINDOW_MS);
    }
  });

  test.each([
    [undefined, 400 * S],
    ["", 400 * S],
    ["abc", 400 * S],
    ["0", 400 * S],
    ["-5", 400 * S],
    ["480000", 480 * S]
  ])("EDGE_WORKER_TIMEOUT_MS %p reads as the demuxer reads it", (raw, expected) => {
    expect(cw.isolateLifetimeMs(raw as string | undefined)).toBe(expected);
  });
});
