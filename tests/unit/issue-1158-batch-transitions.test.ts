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
import { dirname, join } from "path";
import {
  COMPLETED_FROM,
  errorFrom,
  MATCHING_FROM,
  REJECTED_SCAN_ERROR_FROM,
  REVIEW_FROM,
  type BatchStatus
} from "../../supabase/functions/exam-async-worker/batchTransitions";
import {
  MAX_OCR_WAITS,
  nextOcrWait,
  OCR_WAIT_COUNT_MS,
  OCR_WAIT_GUARD_MS,
  ocrWaitBoundaryMs
} from "../../supabase/functions/exam-async-worker/ocrWait";
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

    // The rest of the ownership boundary (examWorkerFence.ts): every disposition of a held message
    // and every match-phase write goes through a claim-checked function, so none may be written
    // directly. The database half is exam-worker-batch-status-db.spec.ts.
    test("no queue call bypasses the claim check", () => {
      expect(source).not.toMatch(/rpc\("archive"/);
      expect(source).not.toMatch(/rpc\("send"/);
      expect(source).not.toMatch(/rpc\("delete"/);
      expect(source).toMatch(/await ack\(admin, fence\)/);
      expect(source).toMatch(/await requeueFenced\(admin, fence, next\.message, next\.delaySeconds, next\.countWait\)/);
      expect(source).toMatch(/await giveUpFenced\(admin, fence, \{/);
    });

    test("no match write bypasses the claim and phase check", () => {
      expect(source).not.toMatch(/rpc\("exam_link_scan_groups"/);
      expect(source).not.toMatch(/matched_profile_id:/);
      expect(source).toMatch(/await linkScanGroups\(\s*admin,\s*fence,/);
      expect(source).toMatch(/await setMatchSuggestion\(admin, fence, batch\.id, scannedId, \{/);
    });

    test("giving up goes through the one-transaction function, with this message's phase", () => {
      expect(source).toMatch(/giveUpMessage\(admin, fence, env, env\.batch_id \?\? null, from, error\)/);
    });

    test("each status write passes its table", () => {
      expect(source).toMatch(/setBatchStatus\(admin, fence, batch\.id, "matching", MATCHING_FROM\)/);
      expect(source.match(/setBatchStatus\(admin, fence, batch\.id, "review", REVIEW_FROM\)/g)).toHaveLength(2);
      expect(source).toMatch(/setBatchStatus\(admin, fence, batchId, "completed", COMPLETED_FROM\)/);
      expect(source).toMatch(
        /const giveUp = async \(error: unknown, from: readonly BatchStatus\[\] = errorFrom\(env\.method\)\)/
      );
      expect(source).toMatch(/await giveUp\(error, REJECTED_SCAN_ERROR_FROM\)/);
    });
  });

  // Aryan's question on #1308, then Jon's and CodeRabbit's counterexamples. Before #1158 every wait
  // re-queued with a 30s delay, computed by pgmq.send from clock_timestamp() at the send, and the
  // 31st read errored the batch. #1308 first errored after 30 waits and 15 minutes (sooner, with a
  // reader every 25s), then counted from the worker's read time (sooner, when the re-queue reaches
  // the database seconds after the read: CodeRabbit's 31s readers and 2s send). Now a counted wait
  // is stamped by the database at the replacement's own send (ocr_wait_from), as the old delay was.
  describe("match gives up on OCR after 30 waits of 31s, and no sooner than before #1158 while sends take as long", () => {
    const S = 1000;
    const MIN = 60 * S;

    test.each([
      // waits, boundaryMs, readDbMs -> result
      [0, undefined, 0, { exhausted: false, waits: 1, counted: true }], // the first wait counts
      [5, 100 * S, 130 * S, { exhausted: false, waits: 5, counted: false }], // 30s on: still inside the guard
      [5, 100 * S, 131 * S - 1, { exhausted: false, waits: 5, counted: false }],
      [5, 100 * S, 131 * S, { exhausted: false, waits: 6, counted: true }], // 30s + 1s guard: counted
      [29, 0, 31 * S, { exhausted: false, waits: 30, counted: true }],
      [30, 0, 30 * S, { exhausted: false, waits: 30, counted: false }], // limit reached, but too soon
      [30, 0, 31 * S, { exhausted: true }],
      [30, undefined, 0, { exhausted: true }]
    ])("nextOcrWait(%p, %p, %p)", (waits, boundaryMs, readDbMs, expected) => {
      expect(nextOcrWait(waits, boundaryMs, readDbMs)).toEqual(expected);
    });

    test("the boundary is the stamp; a message an older worker re-queued uses its enqueued_at", () => {
      expect(ocrWaitBoundaryMs(3, "2026-11-22T10:00:00.000Z", 5)).toBe(Date.parse("2026-11-22T10:00:00.000Z"));
      // Before the first counted wait there is no boundary: the first read counts.
      expect(ocrWaitBoundaryMs(0, undefined, 5)).toBeUndefined();
      // Re-queued by staging (30s delay) or by the previous #1308 rule (ocr_wait_counted_ms): no
      // stamp, so enqueued_at, the send's now(), which is no later than its clock_timestamp().
      expect(ocrWaitBoundaryMs(4, undefined, 777)).toBe(777);
      expect(ocrWaitBoundaryMs(4, "not a date", 777)).toBe(777);
    });

    // A schedule: when readers reach the waiting message if it is visible, how long a read takes to
    // reach its re-queue's send, any extra wait for the claim lock (new rule only), and how long the
    // re-queue's transaction stays uncommitted. `sendLatency` is staging's; `newSendLatency`, when
    // set, is this rule's, for the two paths taking different times (default: the same).
    type Readers = (t: number) => number;
    type Schedule = {
      readers: Readers;
      sendLatency: number;
      newSendLatency?: number;
      lockWait?: number;
      commitDelay?: number;
    };
    const every =
      (gap: number, offset = 0): Readers =>
      (t) =>
        offset + Math.ceil(Math.max(0, t - offset) / gap) * gap;
    const irregular = (seed: number): Readers => {
      const times: number[] = [0];
      let x = seed;
      while (times[times.length - 1] < 8 * 60 * MIN) {
        x = (x * 1103515245 + 12345) % 2147483648;
        times.push(times[times.length - 1] + 1 * S + (x % (90 * S)));
      }
      return (t) => times.find((r) => r >= t)!;
    };
    /** Before #1158: every read counts; the replacement is visible 30s after its send, once committed. */
    const stagingErrorsAt = ({ readers, sendLatency, commitDelay = 0 }: Schedule) => {
      let t = readers(0);
      for (let waits = 0; waits < MAX_OCR_WAITS; waits++) {
        const sentAt = t + sendLatency;
        t = readers(Math.max(sentAt + 30 * S, sentAt + commitDelay));
      }
      return t;
    };
    /** Now: 5s re-queues; a counted one is stamped with its own send instant (after the claim lock). */
    const nowErrorsAt = ({
      readers,
      sendLatency,
      newSendLatency = sendLatency,
      lockWait = 0,
      commitDelay = 0
    }: Schedule) => {
      let t = readers(0);
      let waits = 0;
      let boundary: number | undefined;
      for (let reads = 0; reads < 100_000; reads++) {
        const step = nextOcrWait(waits, boundary, t);
        if (step.exhausted) return t;
        const sentAt = t + newSendLatency + lockWait;
        if (step.counted) boundary = sentAt;
        waits = step.waits;
        t = readers(Math.max(sentAt + 5 * S, sentAt + commitDelay));
      }
      throw new Error("never gave up");
    };
    /** The rule this replaces: counted from the worker's read time (b86af546). */
    const readTimeRuleErrorsAt = ({ readers, sendLatency, commitDelay = 0 }: Schedule) => {
      let t = readers(0);
      let waits = 0;
      let counted: number | undefined;
      for (let reads = 0; reads < 100_000; reads++) {
        if (counted === undefined || t - counted >= 30 * S) {
          if (waits >= MAX_OCR_WAITS) return t;
          waits++;
          counted = t;
        }
        const sentAt = t + sendLatency;
        t = readers(Math.max(sentAt + 5 * S, sentAt + commitDelay));
      }
      throw new Error("never gave up");
    };

    const schedules: [string, Schedule][] = [];
    for (const gap of [1, 5, 25, 29, 30, 31, 32, 45, 60]) {
      for (const sendLatency of [0, 2 * S, 5 * S]) {
        schedules.push([`every ${gap}s, send ${sendLatency / S}s`, { readers: every(gap * S), sendLatency }]);
      }
    }
    schedules.push([
      "every 31s, send 2s, lock wait 3s",
      { readers: every(31 * S), sendLatency: 2 * S, lockWait: 3 * S }
    ]);
    schedules.push([
      "every 31s, send 2s, commit 3s late",
      { readers: every(31 * S), sendLatency: 2 * S, commitDelay: 3 * S }
    ]);
    schedules.push(["every 1s, commit 40s late", { readers: every(1 * S), sendLatency: 0, commitDelay: 40 * S }]);
    for (const seed of [1, 42, 7]) {
      for (const sendLatency of [0, 2 * S]) {
        schedules.push([`irregular seed ${seed}, send ${sendLatency / S}s`, { readers: irregular(seed), sendLatency }]);
      }
    }

    test.each(schedules)("%s: never sooner than before #1158", (_name, schedule) => {
      expect(nowErrorsAt(schedule)).toBeGreaterThanOrEqual(stagingErrorsAt(schedule));
    });

    // The comparison with staging assumes this re-queue reaches the database no sooner after its
    // read than staging's send did, give or take the 1s guard (CodeRabbit on #1308). Up to 1s sooner
    // is covered by the guard; more is not, and is not enforced (see ocrWait.ts).
    const unequal: [string, Schedule][] = schedules.flatMap(([name, schedule]) =>
      [0.5 * S, 1 * S]
        .filter((d) => schedule.sendLatency >= d)
        .map((d): [string, Schedule] => [
          `${name}, this re-queue ${d / S}s sooner`,
          { ...schedule, newSendLatency: schedule.sendLatency - d }
        ])
    );
    test.each(unequal)("%s: never sooner than before #1158 (within the guard)", (_name, schedule) => {
      expect(nowErrorsAt(schedule)).toBeGreaterThanOrEqual(stagingErrorsAt(schedule));
    });

    test("past the guard the comparison can fail, but never the 30 waits of 31s", () => {
      const schedule: Schedule = { readers: every(31.5 * S), sendLatency: 2 * S, newSendLatency: 0.5 * S };
      expect(nowErrorsAt(schedule)).toBeLessThan(stagingErrorsAt(schedule));
      expect(nowErrorsAt(schedule) - schedule.readers(0)).toBeGreaterThanOrEqual(30 * 31 * S);
    });

    // What the rule guarantees by itself, whatever the readers and send times: the batch errors only
    // after 30 counted waits, each at least 31s of database time after the previous counted re-queue.
    test.each([...schedules, ...unequal])("%s: not before 30 waits of 31s after the first read", (_name, schedule) => {
      expect(nowErrorsAt(schedule) - schedule.readers(0)).toBeGreaterThanOrEqual(30 * 31 * S);
    });

    test("CodeRabbit's case fails the read-time rule and passes this one", () => {
      const schedule: Schedule = { readers: every(31 * S), sendLatency: 2 * S };
      // The old worker missed every other reader: the replacement was visible 30s after a send 2s
      // after the read, so a reader 31s after the read found it invisible.
      expect(stagingErrorsAt(schedule)).toBe(30 * 62 * S); // 31 minutes
      // Counting from the read time counted every reader, erroring in half the time.
      expect(readTimeRuleErrorsAt(schedule)).toBe(30 * 31 * S); // 15.5 minutes
      expect(readTimeRuleErrorsAt(schedule)).toBeLessThan(stagingErrorsAt(schedule));
      expect(nowErrorsAt(schedule)).toBeGreaterThanOrEqual(stagingErrorsAt(schedule));
    });

    test("with idle readers it still gives up in about 15.5 minutes, not later than 18", () => {
      const idle: Schedule = { readers: every(1 * S), sendLatency: 0 };
      expect(nowErrorsAt(idle)).toBeGreaterThanOrEqual(15 * MIN);
      expect(nowErrorsAt(idle)).toBeLessThanOrEqual(18 * MIN);
    });

    test("the limits are the old count and delay, and doMatch reads both times from the database", () => {
      expect(MAX_OCR_WAITS).toBe(30);
      expect(OCR_WAIT_COUNT_MS).toBe(30 * S);
      expect(OCR_WAIT_GUARD_MS).toBe(1 * S);
      const source = readFileSync(WORKER, "utf8");
      expect(source).toMatch(/readDbMs: Date\.parse\(msg\.vt\) - READ_VISIBILITY_SECONDS \* 1000/);
      expect(source).toMatch(/enqueuedAtMs: Date\.parse\(msg\.enqueued_at\)/);
      expect(source).toMatch(/const step = nextOcrWait\(waits, boundaryMs, read\.readDbMs\);/);
      expect(source).toMatch(/countWait: step\.counted/);
      expect(source).not.toMatch(/Date\.now\(\)[^\n]*nextOcrWait|nextOcrWait\([^)]*Date\.now/);
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

  // #1292 lines up every page of a batch inside match. That is seconds of CPU for a large batch, and
  // the lease on the match message is renewed by a timer, so the whole-batch alignment must give
  // timers a turn. _shared/timerYield.test.ts shows the yielding form does and the synchronous form
  // doesn't; this keeps match on the yielding form.
  test("match aligns a batch through the form that lets the lease timer run", () => {
    const alignment = readFileSync(join(dirname(WORKER), "pageAlignment.ts"), "utf8");
    const alignBatch = alignment.slice(alignment.indexOf("export async function alignBatch"));
    expect(alignBatch).toMatch(/return await requireAlignedYielding\(/);
    expect(alignBatch).not.toMatch(/return requireAligned\(/);
    const source = readFileSync(WORKER, "utf8");
    expect(source).toMatch(/const groups = await alignBatch\(/);
    // requireAligned (one synchronous loop) only for finalize's single exam.
    expect(source.match(/requireAligned\(/g)).toHaveLength(1);
    expect(source).toMatch(/requireAligned\(batchId, \[pages\]/);
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
