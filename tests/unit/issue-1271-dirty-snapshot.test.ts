/**
 * Regression test for the dirty-snapshot gap found in review on #1324.
 *
 * RegionEditor reports "you have unsaved region changes" to the template page by comparing a
 * serialized snapshot of the current structure against the one taken at the last save. The
 * snapshot left `question_client_id` out, so a region's *association* could change without the
 * snapshot changing: delete the saved region for question A, redraw the same rectangle for
 * question B, and the editor reads as clean.
 *
 * That failure is silent in the worst way. The #1271 warning never fires, the Next control looks
 * safe, and the instructor walks to step 2 having lost the reassignment. Scanning then grades
 * against whichever question the region used to belong to.
 */
import { snapshotOf } from "@/app/course/[course_id]/manage/assignments/[assignment_id]/exam/RegionEditor";

type Question = Parameters<typeof snapshotOf>[0][number];
type Region = Parameters<typeof snapshotOf>[1][number];

function question(clientId: string, label: string): Question {
  return {
    id: null,
    client_id: clientId,
    parent_client_id: null,
    level: 3,
    ordinal: 0,
    label,
    answer_type: "free_text",
    points: 1,
    prompt: "",
    choices: [],
    correct_answer: null,
    grading_tolerance: null
  };
}

/**
 * The same rectangle on the same page every time. Only the association differs.
 *
 * `client_id` is deliberately constant across calls. The editor regenerates client_ids on every
 * load, so the snapshot ignores them by design; holding it fixed here keeps that out of the way,
 * leaving `question_client_id` as the only thing these cases vary.
 */
function regionFor(questionClientId: string | null): Region {
  return {
    client_id: "region-under-test",
    question_client_id: questionClientId,
    kind: "answer",
    page_number: 1,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4
  };
}

describe("snapshotOf covers what a save writes (#1324 review)", () => {
  const questions = [question("q-a", "Question A"), question("q-b", "Question B")];

  it("changes when a region is reassigned to a different question", () => {
    // The exact sequence from review: one saved region on A, deleted, redrawn identically on B.
    const saved = snapshotOf(questions, [regionFor("q-a")]);
    const afterRedraw = snapshotOf(questions, [regionFor("q-b")]);

    // Without question_client_id in the snapshot these are equal, `dirty` stays false, and the
    // unsaved-changes warning is structurally unable to fire.
    expect(afterRedraw).not.toEqual(saved);
  });

  it("changes when a region is detached from its question", () => {
    expect(snapshotOf(questions, [regionFor(null)])).not.toEqual(snapshotOf(questions, [regionFor("q-a")]));
  });

  it("does not change when nothing changed", () => {
    // The other half of the contract. A snapshot that always differs would warn on every render
    // and train instructors to ignore the warning, which is the same bug wearing a hat.
    expect(snapshotOf(questions, [regionFor("q-a")])).toEqual(snapshotOf(questions, [regionFor("q-a")]));
  });

  it("still changes when the rectangle moves, association unchanged", () => {
    const moved: Region = { ...regionFor("q-a"), x: 0.5 };
    expect(snapshotOf(questions, [moved])).not.toEqual(snapshotOf(questions, [regionFor("q-a")]));
  });
});
