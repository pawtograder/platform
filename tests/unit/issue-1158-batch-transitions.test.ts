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
  REVIEW_FROM,
  type BatchStatus
} from "../../supabase/functions/exam-async-worker/batchTransitions";

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
    [undefined, ["finalizing", "matching", "ocr"]]
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
      expect(source).toMatch(/setBatchStatus\(admin, fence, batchId, "error", errorFrom\(method\), message\)/);
    });
  });
});
