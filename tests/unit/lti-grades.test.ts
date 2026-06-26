/**
 * @jest-environment node
 *
 * Unit coverage for the grade-passback gating + scoring logic in lib/lti/grades.ts.
 * Before this, the entire grade-sync runtime was exercised ONLY by the
 * workflow_dispatch-only Canvas E2E spec (skipped in per-PR CI), so a regression
 * in the released/excused/null gating, the score_override precedence, the
 * scoreMaximum fallback, or the context selection could ship green. These tests
 * run in the default Jest lane.
 *
 * The DB and the AGS HTTP client are faked so the test asserts pure logic: which
 * scores publish, with what values, to which context's line item.
 */
import { AGS_SCOPE } from "@/lib/lti/types";

// Replace the AGS HTTP client so no network is touched and we can assert calls.
jest.mock("@/lib/lti/ags", () => ({
  ensureLineItem: jest.fn(),
  publishScore: jest.fn(),
  retractScore: jest.fn()
}));
// Avoid pulling in the real service-role Supabase client (it needs env / a
// realtime worker). syncAssignmentGrades always receives an explicit db here,
// so the default factory is never invoked.
jest.mock("@/lib/lti/db", () => ({
  ltiAdminClient: jest.fn(() => {
    throw new Error("ltiAdminClient() should not be called when a db is passed");
  })
}));

import { syncAssignmentGrades, drainGradeSyncQueue } from "@/lib/lti/grades";
import { ensureLineItem, publishScore, retractScore } from "@/lib/lti/ags";

const ensureLineItemMock = ensureLineItem as jest.Mock;
const publishScoreMock = publishScore as jest.Mock;
const retractScoreMock = retractScore as jest.Mock;

type TableResult = { data: unknown; error?: unknown };
type Fixtures = Record<string, TableResult>;

/** A minimal thenable PostgREST-style query builder backed by per-table fixtures.
 *  Every chained method returns the same builder; awaiting it (or any terminal
 *  like .single()/.maybeSingle()) resolves to that table's fixture. */
function makeFakeDb(fixtures: Fixtures) {
  const upserts: Array<{ table: string; rows: unknown }> = [];
  const deletes: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const from = (table: string) => {
    const result: TableResult = fixtures[table] ?? { data: null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.in = chain;
    builder.not = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.single = chain;
    builder.maybeSingle = chain;
    builder.update = chain;
    builder.upsert = (rows: unknown) => {
      upserts.push({ table, rows });
      return builder;
    };
    // Delete records the eq() filters it was given, so a test can assert e.g.
    // the drain delete is guarded by enqueued_at.
    builder.delete = () => {
      const filters: Record<string, unknown> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const del: any = {};
      del.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return del;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      del.then = (resolve: any, reject: any) => {
        deletes.push({ table, filters });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      };
      return del;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    builder.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve, reject);
    return builder;
  };
  // lti_upsert_line_item returns the line item id; default to 1 (override via the
  // `__line_item_id` fixture). The reconcile compares prev.line_item_id to this.
  const rpc = (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    const id = (fixtures.__line_item_id?.data as number | undefined) ?? 1;
    return Promise.resolve({ data: id, error: null });
  };
  return {
    db: { from, rpc } as unknown as Parameters<typeof syncAssignmentGrades>[2],
    upserts,
    deletes,
    rpcCalls
  };
}

/** A baseline happy-path fixture set; tests override individual tables. */
function baseFixtures(overrides: Partial<Fixtures> = {}): Fixtures {
  return {
    lti_context_links: {
      data: [
        {
          id: 1,
          platform_id: 10,
          ags_lineitems_url: "https://canvas.test/li",
          ags_scopes: [AGS_SCOPE.score, AGS_SCOPE.lineItem],
          section_role: "lecture"
        }
      ]
    },
    assignments: {
      data: { id: 5, class_id: 100, title: "HW1", slug: "hw1", total_points: 50, gradebook_column_id: 7 }
    },
    gradebook_columns: { data: { id: 7, max_score: 50 } },
    gradebook_column_students: { data: [] },
    user_roles: { data: [{ user_id: "u1", private_profile_id: "p1" }] },
    lti_users: { data: [{ user_id: "u1", sub: "sub-1", email: null }] },
    // reconcile reads the line-item row id (.select("id").single()) and the
    // prior per-student sync state; default to a fresh line item and no history.
    lti_line_items: { data: { id: 1 } },
    lti_grade_sync_state: { data: [] },
    ...overrides
  };
}

beforeEach(() => {
  ensureLineItemMock.mockReset().mockResolvedValue({ id: "https://canvas.test/li/1", created: true });
  publishScoreMock.mockReset().mockResolvedValue(undefined);
  retractScoreMock.mockReset().mockResolvedValue(undefined);
});

describe("syncAssignmentGrades — grade gating", () => {
  test("publishes a released, non-excused, numeric score", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(publishScoreMock).toHaveBeenCalledTimes(1);
    const score = publishScoreMock.mock.calls[0][2];
    expect(score).toMatchObject({ userId: "sub-1", scoreGiven: 40, scoreMaximum: 50 });
  });

  test("score_override takes precedence over score", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: 88, released: true, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(1);
    expect(publishScoreMock.mock.calls[0][2].scoreGiven).toBe(88);
  });

  test("an explicit score_override of 0 still publishes (not treated as empty)", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: null, score_override: 0, released: true, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(1);
    expect(publishScoreMock.mock.calls[0][2].scoreGiven).toBe(0);
  });

  test("unreleased grades are not pushed", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: false, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(publishScoreMock).not.toHaveBeenCalled();
  });

  test("excused grades are not pushed", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: true }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(publishScoreMock).not.toHaveBeenCalled();
  });

  test("null (empty) grades are not pushed", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: null, score_override: null, released: true, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(publishScoreMock).not.toHaveBeenCalled();
  });

  test("a student with no LTI identity is skipped and recorded as a failure", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: false }]
        },
        lti_users: { data: [] } // no sub mapped for u1
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([{ studentId: "p1", reason: "No LTI identity mapped for student" }]);
    expect(publishScoreMock).not.toHaveBeenCalled();
  });
});

describe("syncAssignmentGrades — reconcile against prior sync state", () => {
  test("a score already in sync skips the network round-trip", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: false }]
        },
        lti_grade_sync_state: {
          data: [
            {
              student_profile_id: "p1",
              lti_user_sub: "sub-1",
              synced_score: 40,
              line_item_id: 1,
              status: "synced",
              attempts: 1
            }
          ]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(publishScoreMock).not.toHaveBeenCalled();
  });

  test("re-publishes a synced score when the column max changed (Canvas re-scales)", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        // current max is 50; the prior push recorded a line item with max 25.
        gradebook_columns: { data: { id: 7, max_score: 50 } },
        lti_line_items: { data: { id: 1, score_maximum: 25 } },
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: false }]
        },
        lti_grade_sync_state: {
          data: [
            {
              student_profile_id: "p1",
              lti_user_sub: "sub-1",
              synced_score: 40,
              line_item_id: 1,
              status: "synced",
              attempts: 1
            }
          ]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(publishScoreMock.mock.calls[0][2].scoreMaximum).toBe(50);
  });

  test("re-publishes a synced score when the prior push targeted a different line item", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 40, score_override: null, released: true, is_excused: false }]
        },
        // prior sync targeted line item 99; the current push resolves to id 1, so
        // the student must be re-published to the new line item, not skipped.
        lti_grade_sync_state: {
          data: [
            {
              student_profile_id: "p1",
              lti_user_sub: "sub-1",
              synced_score: 40,
              line_item_id: 99,
              status: "synced",
              attempts: 1
            }
          ]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  test("a previously-synced grade that is no longer released is retracted", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: null, score_override: null, released: false, is_excused: false }]
        },
        lti_grade_sync_state: {
          data: [{ student_profile_id: "p1", lti_user_sub: "sub-1", synced_score: 73, status: "synced", attempts: 1 }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.retracted).toBe(1);
    expect(result.pushed).toBe(0);
    expect(retractScoreMock).toHaveBeenCalledTimes(1);
    // retractScore(platformId, lineItemUrl, sub, db)
    expect(retractScoreMock.mock.calls[0][2]).toBe("sub-1");
    expect(publishScoreMock).not.toHaveBeenCalled();
  });

  test("a never-synced, non-releasable grade is neither pushed nor retracted", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_column_students: {
          data: [{ student_id: "p1", score: null, score_override: null, released: false, is_excused: false }]
        }
      })
    );
    const result = await syncAssignmentGrades(100, 5, db);
    expect(result.skipped).toBe(1);
    expect(retractScoreMock).not.toHaveBeenCalled();
    expect(publishScoreMock).not.toHaveBeenCalled();
  });
});

describe("syncAssignmentGrades — scoreMaximum", () => {
  test("a 0-point column/assignment falls back to a positive scoreMaximum (no Canvas div-by-zero)", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        assignments: {
          data: { id: 5, class_id: 100, title: "Survey", slug: "survey", total_points: 0, gradebook_column_id: 7 }
        },
        gradebook_columns: { data: { id: 7, max_score: 0 } },
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 1, score_override: null, released: true, is_excused: false }]
        }
      })
    );
    await syncAssignmentGrades(100, 5, db);
    expect(ensureLineItemMock.mock.calls[0][2].scoreMaximum).toBe(100);
    expect(publishScoreMock.mock.calls[0][2].scoreMaximum).toBe(100);
  });

  test("uses the column max_score when present", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        gradebook_columns: { data: { id: 7, max_score: 25 } },
        gradebook_column_students: {
          data: [{ student_id: "p1", score: 10, score_override: null, released: true, is_excused: false }]
        }
      })
    );
    await syncAssignmentGrades(100, 5, db);
    expect(ensureLineItemMock.mock.calls[0][2].scoreMaximum).toBe(25);
  });
});

describe("syncAssignmentGrades — context selection", () => {
  test("prefers the lecture context over a lower-id non-lecture context", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        lti_context_links: {
          data: [
            {
              id: 1,
              platform_id: 11,
              ags_lineitems_url: "lab-url",
              ags_scopes: [AGS_SCOPE.score],
              section_role: "lab"
            },
            {
              id: 2,
              platform_id: 12,
              ags_lineitems_url: "lecture-url",
              ags_scopes: [AGS_SCOPE.score],
              section_role: "lecture"
            }
          ]
        }
      })
    );
    await syncAssignmentGrades(100, 5, db);
    // ensureLineItem(platformId, lineItemsUrl, ...)
    expect(ensureLineItemMock.mock.calls[0][0]).toBe(12);
    expect(ensureLineItemMock.mock.calls[0][1]).toBe("lecture-url");
  });

  test("throws when the class has no grade-sync-enabled context", async () => {
    const { db } = makeFakeDb(baseFixtures({ lti_context_links: { data: [] } }));
    await expect(syncAssignmentGrades(100, 5, db)).rejects.toThrow(/no LTI context with grade sync enabled/i);
  });

  test("throws when the assignment has no gradebook column", async () => {
    const { db } = makeFakeDb(
      baseFixtures({
        assignments: {
          data: { id: 5, class_id: 100, title: "HW1", slug: "hw1", total_points: 50, gradebook_column_id: null }
        }
      })
    );
    await expect(syncAssignmentGrades(100, 5, db)).rejects.toThrow(/no gradebook column/i);
  });
});

describe("drainGradeSyncQueue — concurrency-safe dequeue", () => {
  test("deletes the queue row guarded by the enqueued_at it read", async () => {
    const { db, deletes } = makeFakeDb(
      baseFixtures({
        lti_grade_sync_queue: {
          data: [{ class_id: 100, assignment_id: 5, enqueued_at: "2026-06-26T00:00:00.000Z" }]
        }
      })
    );
    await drainGradeSyncQueue(db);
    const queueDeletes = deletes.filter((d) => d.table === "lti_grade_sync_queue");
    expect(queueDeletes).toHaveLength(1);
    // The delete must carry the enqueued_at it read, so a re-enqueue mid-sync
    // (which bumps enqueued_at) is NOT clobbered — that work survives for the
    // next drain instead of being silently dropped.
    expect(queueDeletes[0].filters).toEqual({
      class_id: 100,
      assignment_id: 5,
      enqueued_at: "2026-06-26T00:00:00.000Z"
    });
  });
});
