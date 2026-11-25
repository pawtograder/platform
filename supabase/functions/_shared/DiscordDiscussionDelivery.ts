/**
 * Whether a queued Discord message about a discussion thread may still be sent or updated (#1010).
 *
 * The database only queues messages for public, published questions, but an envelope can sit in the
 * queue while the thread changes: made private, turned back into a draft, merged into another thread
 * (it then has a parent), or deleted. The worker reads the thread again right before the Discord call
 * and drops the envelope unless this says yes. A thread made private also gets its message deleted
 * (the delete_message envelope), so it never stays on Discord.
 */
export type DiscussionThreadDeliveryRow = {
  instructors_only: boolean;
  draft: boolean;
  parent: number | null;
};

export function discussionThreadStillPostable(row: DiscussionThreadDeliveryRow | null | undefined): boolean {
  if (!row) return false;
  return row.instructors_only === false && row.draft === false && row.parent === null;
}

/**
 * The steps settleDiscussionThreadSend takes, passed in so it can be tested without Supabase or
 * Discord. The worker supplies the real ones.
 */
export type DiscussionSendSettleSteps = {
  /** Record the message as the thread's. "taken": another send for this thread recorded its own first. */
  track(): Promise<"tracked" | "taken" | "failed">;
  /** Whether the thread is still a public question; null if it couldn't be read. */
  postable(): Promise<boolean | null>;
  /** Whether the thread changed after this message was first queued. */
  changedSinceQueued(): Promise<boolean>;
  /** Delete the message and its tracking row. Throws if Discord refused. */
  deleteMessage(): Promise<void>;
  /** Queue a delete_message (it keeps the message if it is the thread's own and the thread is public by then). */
  queueDelete(): Promise<void>;
  /** Queue the thread's message. The database queues it only for a public question. */
  enqueue(action: "created" | "updated"): Promise<void>;
};

export type DiscussionSendSettlement = "kept" | "updated" | "duplicate_deleted" | "deleted" | "delete_queued";

/**
 * Right after a discussion thread's message is sent (#1010). The thread's database triggers can't
 * act on a message that wasn't recorded yet, so the worker covers what happened while it was sending:
 *   - another send for the same thread recorded its message first: this one is a duplicate, deleted;
 *   - the thread was made private (or merged, turned into a draft, deleted), or the message couldn't
 *     be recorded (nothing could update or delete it later): the message is deleted, or a delete
 *     queued if Discord refused or the thread couldn't be read. Then the thread is queued again,
 *     which posts it, recorded, only if it is a public question by then;
 *   - the thread was edited, or its poster hidden: an update is queued.
 */
export async function settleDiscussionThreadSend(steps: DiscussionSendSettleSteps): Promise<DiscussionSendSettlement> {
  const tracked = await steps.track();
  if (tracked === "taken") {
    try {
      await steps.deleteMessage();
    } catch {
      await steps.queueDelete();
    }
    return "duplicate_deleted";
  }
  const postable = tracked === "failed" ? false : await steps.postable();
  if (postable === true) {
    if (await steps.changedSinceQueued()) {
      await steps.enqueue("updated");
      return "updated";
    }
    return "kept";
  }
  if (postable === false) {
    try {
      await steps.deleteMessage();
    } catch {
      await steps.queueDelete();
      return "delete_queued";
    }
    await steps.enqueue("created");
    return "deleted";
  }
  await steps.queueDelete();
  return "delete_queued";
}

/**
 * Whether a thread changed after its message was first queued (#1010): an edit, or a change of the
 * shown author, made while the first message waited found no message to update. `updated_at` moves
 * on any change, so this can queue an update that changes nothing, which is harmless.
 */
export function discussionThreadChangedSince(updatedAt: string | null | undefined, enqueuedAt: string): boolean {
  if (!updatedAt) return false;
  const updated = Date.parse(updatedAt);
  const enqueued = Date.parse(enqueuedAt);
  if (Number.isNaN(updated) || Number.isNaN(enqueued)) return false;
  return updated > enqueued;
}
