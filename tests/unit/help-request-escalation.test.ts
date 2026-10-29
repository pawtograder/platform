/**
 * @jest-environment node
 */

/**
 * Queue-order and check-in rules for office hours escalation (docs/prd-oh-escalation.md).
 *
 * The comparator drives four separate views (student position, sidebar, staff working view,
 * staff request list). If it is wrong, an escalated student silently loses their place again,
 * which is the problem this feature exists to fix.
 */

import {
  compareHelpRequestQueueOrder,
  escalationBadgeLabel,
  formatWaitDuration,
  isCheckInPending,
  isValidEscalationNote,
  latestEscalationNoteByRequest,
  totalQueueWaitMs,
  ESCALATION_NOTE_MAX_LENGTH
} from "../../lib/helpRequestEscalation";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 29, 18, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

describe("compareHelpRequestQueueOrder", () => {
  const normalOld = { id: 1, escalation_count: 0, created_at: at(0) };
  const normalNew = { id: 2, escalation_count: 0, created_at: at(10) };
  const escalatedNew = { id: 3, escalation_count: 1, created_at: at(20) };
  const escalatedOld = { id: 4, escalation_count: 2, created_at: at(5) };

  it("puts escalated tickets ahead of older normal tickets", () => {
    expect([normalOld, escalatedNew].sort(compareHelpRequestQueueOrder).map((r) => r.id)).toEqual([3, 1]);
  });

  it("orders escalated tickets by original creation time, not escalation count", () => {
    const sorted = [normalNew, escalatedNew, normalOld, escalatedOld].sort(compareHelpRequestQueueOrder);
    expect(sorted.map((r) => r.id)).toEqual([4, 3, 1, 2]);
  });

  it("keeps normal tickets oldest first", () => {
    expect([normalNew, normalOld].sort(compareHelpRequestQueueOrder).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("isCheckInPending", () => {
  const now = T0;
  it("is true for a resolved ticket inside its window", () => {
    expect(isCheckInPending({ status: "resolved", check_in_expires_at: at(5) }, now)).toBe(true);
  });
  it.each([
    ["window passed", { status: "resolved", check_in_expires_at: at(-1) }],
    ["no window (student resolved it)", { status: "resolved", check_in_expires_at: null }],
    ["ended by staff", { status: "closed", check_in_expires_at: null }],
    ["still open", { status: "open", check_in_expires_at: at(5) }]
  ])("is false when %s", (_label, request) => {
    expect(isCheckInPending(request, now)).toBe(false);
  });
});

describe("totalQueueWaitMs", () => {
  it("counts the wait before the first pickup", () => {
    expect(totalQueueWaitMs({ created_at: at(0), status: "in_progress" }, [{ started_at: at(12) }], [], T0)).toBe(
      12 * MINUTE
    );
  });

  it("sums waits across escalations and pickups", () => {
    const sessions = [{ started_at: at(10) }, { started_at: at(25) }];
    const escalations = [{ created_at: at(20) }];
    expect(totalQueueWaitMs({ created_at: at(0), status: "in_progress" }, sessions, escalations, T0)).toBe(15 * MINUTE);
  });

  it("includes the current wait for an escalated ticket still in line", () => {
    const sessions = [{ started_at: at(10) }];
    const escalations = [{ created_at: at(20) }];
    expect(totalQueueWaitMs({ created_at: at(0), status: "open" }, sessions, escalations, T0 + 26 * MINUTE)).toBe(
      16 * MINUTE
    );
  });

  it("does not count the check-in window between Resolve and a student escalation", () => {
    // Picked up at 10, resolved at 20, student escalated at 28, picked up again at 30.
    const sessions = [{ started_at: at(10) }, { started_at: at(30) }];
    const escalations = [{ created_at: at(28) }];
    expect(totalQueueWaitMs({ created_at: at(0), status: "in_progress" }, sessions, escalations, T0)).toBe(12 * MINUTE);
  });
});

describe("notes and labels", () => {
  it.each([
    ["empty", "", false],
    ["whitespace", "   ", false],
    ["at the limit", "a".repeat(ESCALATION_NOTE_MAX_LENGTH), true],
    ["over the limit", "a".repeat(ESCALATION_NOTE_MAX_LENGTH + 1), false]
  ])("validates a note (%s)", (_label, note, valid) => {
    expect(isValidEscalationNote(note)).toBe(valid);
  });

  it("labels repeat escalations with a count", () => {
    expect(escalationBadgeLabel(0)).toBeNull();
    expect(escalationBadgeLabel(1)).toBe("Escalated");
    expect(escalationBadgeLabel(3)).toBe("Escalated ×3");
  });

  it("picks the most recent note per request", () => {
    const notes = latestEscalationNoteByRequest([
      { help_request_id: 7, note: "second", created_at: at(5) },
      { help_request_id: 7, note: "first", created_at: at(1) },
      { help_request_id: 8, note: "only", created_at: at(2) }
    ]);
    expect(notes.get(7)).toBe("second");
    expect(notes.get(8)).toBe("only");
  });

  it("formats wait durations", () => {
    expect(formatWaitDuration(18 * MINUTE)).toBe("18 min");
    expect(formatWaitDuration(65 * MINUTE)).toBe("1 hr 5 min");
  });
});
