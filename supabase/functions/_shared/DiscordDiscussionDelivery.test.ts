/**
 * Unit tests for the Discord worker's decisions about a discussion thread's message (#1010): its last
 * check before a send or update, and what it does right after a send (settleDiscussionThreadSend).
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordDiscussionDelivery.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  type DiscussionSendSettleSteps,
  discussionThreadChangedSince,
  discussionThreadStillPostable,
  settleDiscussionThreadSend
} from "./DiscordDiscussionDelivery.ts";

const publicQuestion = { instructors_only: false, draft: false, parent: null };

Deno.test("discussionThreadStillPostable: a public, published question is delivered", () => {
  assertEquals(discussionThreadStillPostable(publicQuestion), true);
});

Deno.test("discussionThreadStillPostable: a thread made private is not", () => {
  assertEquals(discussionThreadStillPostable({ ...publicQuestion, instructors_only: true }), false);
});

Deno.test("discussionThreadStillPostable: a draft is not", () => {
  assertEquals(discussionThreadStillPostable({ ...publicQuestion, draft: true }), false);
});

Deno.test("discussionThreadStillPostable: a question merged into another thread is not", () => {
  assertEquals(discussionThreadStillPostable({ ...publicQuestion, parent: 42 }), false);
});

Deno.test("discussionThreadStillPostable: a deleted thread is not", () => {
  assertEquals(discussionThreadStillPostable(null), false);
  assertEquals(discussionThreadStillPostable(undefined), false);
});

/** Fake steps that record what settleDiscussionThreadSend did. */
function fakeSteps(world: {
  track: "tracked" | "taken" | "failed";
  postable: boolean | null;
  changed?: boolean;
  deleteFails?: boolean;
}) {
  const did: string[] = [];
  const steps: DiscussionSendSettleSteps = {
    track: () => Promise.resolve(world.track),
    postable: () => Promise.resolve(world.postable),
    changedSinceQueued: () => Promise.resolve(world.changed ?? false),
    deleteMessage: () => {
      if (world.deleteFails) return Promise.reject(new Error("Discord said no"));
      did.push("delete");
      return Promise.resolve();
    },
    queueDelete: () => {
      did.push("queue delete");
      return Promise.resolve();
    },
    enqueue: (action) => {
      did.push(`enqueue ${action}`);
      return Promise.resolve();
    }
  };
  return { steps, did };
}

Deno.test("settle: a thread still public keeps its message", async () => {
  const { steps, did } = fakeSteps({ track: "tracked", postable: true });
  assertEquals(await settleDiscussionThreadSend(steps), "kept");
  assertEquals(did, []);
});

Deno.test("settle: a thread edited while its message was queued gets an update", async () => {
  const { steps, did } = fakeSteps({ track: "tracked", postable: true, changed: true });
  assertEquals(await settleDiscussionThreadSend(steps), "updated");
  assertEquals(did, ["enqueue updated"]);
});

Deno.test("settle: a second send in flight deletes its own message, and queues the delete if that fails", async () => {
  const first = fakeSteps({ track: "taken", postable: true });
  assertEquals(await settleDiscussionThreadSend(first.steps), "duplicate_deleted");
  assertEquals(first.did, ["delete"]);
  const refused = fakeSteps({ track: "taken", postable: true, deleteFails: true });
  assertEquals(await settleDiscussionThreadSend(refused.steps), "duplicate_deleted");
  assertEquals(refused.did, ["queue delete"]);
});

Deno.test(
  "settle: a thread made private during the send loses its message, and is posted if public again",
  async () => {
    const { steps, did } = fakeSteps({ track: "tracked", postable: false });
    assertEquals(await settleDiscussionThreadSend(steps), "deleted");
    // enqueue("created") posts only a public question with no message, so it is a no-op if still private.
    assertEquals(did, ["delete", "enqueue created"]);
  }
);

Deno.test("settle: a refused delete, or a thread that can't be read, queues a delete", async () => {
  const refused = fakeSteps({ track: "tracked", postable: false, deleteFails: true });
  assertEquals(await settleDiscussionThreadSend(refused.steps), "delete_queued");
  assertEquals(refused.did, ["queue delete"]);
  const unread = fakeSteps({ track: "tracked", postable: null });
  assertEquals(await settleDiscussionThreadSend(unread.steps), "delete_queued");
  assertEquals(unread.did, ["queue delete"]);
});

Deno.test(
  "settle: a message that couldn't be recorded is deleted and the thread queued again, even if public",
  async () => {
    // Untracked, nothing could update or delete it later; queued again, it is posted and recorded.
    const { steps, did } = fakeSteps({ track: "failed", postable: true, changed: true });
    assertEquals(await settleDiscussionThreadSend(steps), "deleted");
    assertEquals(did, ["delete", "enqueue created"]);
  }
);

Deno.test("a thread edited after its message was first queued counts as changed", () => {
  assertEquals(discussionThreadChangedSince("2026-11-24T10:00:05Z", "2026-11-24T10:00:00Z"), true);
});

Deno.test("a thread not changed since then doesn't", () => {
  assertEquals(discussionThreadChangedSince("2026-11-24T09:59:00Z", "2026-11-24T10:00:00Z"), false);
  assertEquals(discussionThreadChangedSince(null, "2026-11-24T10:00:00Z"), false);
  assertEquals(discussionThreadChangedSince("not a date", "2026-11-24T10:00:00Z"), false);
});
