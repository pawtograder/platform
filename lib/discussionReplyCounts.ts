/**
 * How many of a thread's replies are new to the viewer (#1010): their unread marks for its replies.
 * The database makes unread marks only for the people who can read a post, and removes them when
 * they no longer can, so this never counts a reply the viewer can't read. Subtracting the read marks
 * from the thread's reply count didn't work: a reply the viewer can't read has no mark, so its
 * "N new" never cleared. The question's own mark isn't a reply.
 */
export function unreadDiscussionReplyCount(
  rootId: number,
  statuses: ReadonlyArray<{ discussion_thread_id: number; read_at: string | null }> | null | undefined
): number {
  return statuses?.filter((s) => s.discussion_thread_id !== rootId && s.read_at == null).length ?? 0;
}
