import { unreadDiscussionReplyCount } from "@/lib/discussionReplyCounts";

// "N new" on discussion lists counts only replies the viewer can read (#1010).
describe("unreadDiscussionReplyCount", () => {
  it("counts the viewer's unread marks for the thread's replies, not the question's own", () => {
    const statuses = [
      { discussion_thread_id: 1, read_at: null },
      { discussion_thread_id: 2, read_at: null },
      { discussion_thread_id: 3, read_at: "2026-11-24T10:00:00Z" },
      { discussion_thread_id: 4, read_at: null }
    ];
    expect(unreadDiscussionReplyCount(1, statuses)).toBe(2);
  });

  it("is 0 with no marks, so a reply the viewer can't read (and has no mark for) is never new", () => {
    expect(unreadDiscussionReplyCount(1, [])).toBe(0);
    expect(unreadDiscussionReplyCount(1, undefined)).toBe(0);
  });
});
