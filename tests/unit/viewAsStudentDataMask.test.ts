import {
  isDiscussionTeaserVisibleToStudent,
  isDiscussionThreadRowVisibleToStudent,
  isHelpRequestVisibleToStudent,
  studentProfileIdSet,
  filterHelpRequestsForStudentView,
  buildHelpRequestMembersMap,
  pickGradebookEntryForCaller,
  filterGradebookEntriesForCaller,
  filterGradebookColumnsForStudentView
} from "@/lib/viewAsStudentDataMask";

const studentPrivate = "student-private-id";
const studentPublic = "student-public-id";
const otherStudent = "other-student-id";
const studentIds = studentProfileIdSet(studentPrivate, studentPublic);

describe("viewAsStudentDataMask", () => {
  describe("discussion visibility", () => {
    it("shows public threads to any student", () => {
      expect(isDiscussionTeaserVisibleToStudent({ instructors_only: false, author: otherStudent }, studentIds)).toBe(
        true
      );
    });

    it("hides staff-only threads unless the student authored the root", () => {
      expect(isDiscussionTeaserVisibleToStudent({ instructors_only: true, author: otherStudent }, studentIds)).toBe(
        false
      );
      expect(isDiscussionTeaserVisibleToStudent({ instructors_only: true, author: studentPrivate }, studentIds)).toBe(
        true
      );
    });

    it("allows staff-only participation when the student replied in the thread", () => {
      const root = { instructors_only: true, author: otherStudent };
      const reply = { author: studentPublic };
      expect(isDiscussionThreadRowVisibleToStudent(root, studentIds, [root, reply])).toBe(true);
    });
  });

  describe("help request visibility", () => {
    it("shows public requests in the queue", () => {
      expect(isHelpRequestVisibleToStudent({ is_private: false, created_by: otherStudent }, studentIds)).toBe(true);
    });

    it("hides private requests unless the student is involved", () => {
      expect(isHelpRequestVisibleToStudent({ is_private: true, created_by: otherStudent }, studentIds)).toBe(false);
      expect(isHelpRequestVisibleToStudent({ is_private: true, created_by: studentPrivate }, studentIds)).toBe(true);
      expect(
        isHelpRequestVisibleToStudent(
          { is_private: true, created_by: otherStudent, assignee: studentPublic },
          studentIds
        )
      ).toBe(true);
      expect(
        isHelpRequestVisibleToStudent({ is_private: true, created_by: otherStudent }, studentIds, [studentPrivate])
      ).toBe(true);
    });

    it("filters a request list using member associations", () => {
      const requests = [
        { id: 1, is_private: false, created_by: otherStudent },
        { id: 2, is_private: true, created_by: otherStudent },
        { id: 3, is_private: true, created_by: studentPrivate }
      ];
      const members = buildHelpRequestMembersMap([{ help_request_id: 2, profile_id: studentPublic }]);
      const visible = filterHelpRequestsForStudentView(requests, studentIds, members);
      expect(visible.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    });
  });

  describe("gradebook visibility", () => {
    const entries = [
      { gc_id: 1, is_private: true, score: 90 },
      { gc_id: 1, is_private: false, score: 85 },
      { gc_id: 2, is_private: false, score: 70 }
    ];

    it("staff picks private rows; students only see public rows", () => {
      expect(pickGradebookEntryForCaller(entries, 1, true)?.score).toBe(90);
      expect(pickGradebookEntryForCaller(entries, 1, false)?.score).toBe(85);
      expect(pickGradebookEntryForCaller(entries, 2, false)?.score).toBe(70);
    });

    it("filters entry lists by caller role", () => {
      expect(filterGradebookEntriesForCaller(entries, true).map((e) => e.score)).toEqual([90]);
      expect(filterGradebookEntriesForCaller(entries, false).map((e) => e.score)).toEqual([85, 70]);
    });

    it("hides instructor-only columns until released", () => {
      const columns = [
        { id: 1, instructor_only: false, released: false },
        { id: 2, instructor_only: true, released: false },
        { id: 3, instructor_only: true, released: true }
      ];
      expect(filterGradebookColumnsForStudentView(columns).map((c) => c.id)).toEqual([1, 3]);
    });
  });
});
