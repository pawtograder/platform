/**
 * The membership hint an enqueuer can attach to an `add_member_role` envelope.
 *
 * processBatchRoleSync() reads `GET /guilds/{g}/members/{u}` for every candidate and then enqueues an
 * add_member_role whose handler used to read the very same endpoint again about a second later. Two
 * identical calls per user, the second wave four-wide in parallel, is what emptied Discord's
 * per-route bucket -- the 429s all landed on the second call, with `remaining: 0` and a sub-second
 * reset. That is a route bucket, which the shared 50/s global limiter cannot see, so the fix is to
 * stop making the duplicate call rather than to throttle harder.
 *
 * Kept out of the worker so it can be tested without standing up the whole handler.
 */

/**
 * How long an enqueuer's observation is worth trusting.
 *
 * The batch sync enqueues and the worker picks the message up on its next iteration, normally within
 * a second or two, so this only has to cover a healthy hand-off -- not a message that was retried,
 * delayed by backoff, or redelivered after its visibility timeout. Two minutes is generous for the
 * first and far short of the second.
 */
export const MEMBERSHIP_HINT_TTL_MS = 120_000;

/**
 * Age of a usable membership hint, or undefined when there is none worth trusting.
 *
 * Undefined for absent, unparseable and expired alike: every one of them means "look it up", and
 * collapsing them here keeps the call site from having to care which.
 *
 * A timestamp from the future is refused rather than clamped. Clock skew between the enqueuer and
 * this isolate is the only thing that produces one, and accepting it would extend the trust window
 * by the size of the skew -- silently, and by an amount nothing here can measure.
 */
export function freshMembershipHintAgeMs(verifiedAt: string | undefined | null): number | undefined {
  if (!verifiedAt) return undefined;
  const observedMs = Date.parse(verifiedAt);
  if (Number.isNaN(observedMs)) return undefined;
  const ageMs = Date.now() - observedMs;
  if (ageMs < 0 || ageMs > MEMBERSHIP_HINT_TTL_MS) return undefined;
  return ageMs;
}
