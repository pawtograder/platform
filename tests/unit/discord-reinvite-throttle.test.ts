/**
 * @jest-environment node
 */
import { canRetryAny } from "@/components/discord/reinvite-button";
import type { DiscordMembershipRow } from "@/hooks/useDiscordMembershipStatus";

// Only last_retry_requested_at matters to the helper; the rest of the row is irrelevant here.
function row(lastRetryRequestedAt: string | null): DiscordMembershipRow {
  return { last_retry_requested_at: lastRetryRequestedAt } as unknown as DiscordMembershipRow;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();

describe("canRetryAny", () => {
  it("allows a retry for a row that has never been retried", () => {
    expect(canRetryAny([row(null)])).toBe(true);
  });

  it("blocks a retry inside the five-minute window", () => {
    expect(canRetryAny([row(minutesAgo(1))])).toBe(false);
  });

  it("allows a retry once the window has passed", () => {
    expect(canRetryAny([row(minutesAgo(6))])).toBe(true);
  });

  // The button covers a group, and request_discord_reinvite() skips throttled users individually
  // rather than refusing the whole call. Disabling the button because *some* of the group is
  // throttled would strand the rest, so one eligible row is enough to enable it.
  it("allows a retry when any row in the group is eligible", () => {
    expect(canRetryAny([row(minutesAgo(1)), row(minutesAgo(30))])).toBe(true);
  });

  it("blocks a retry only when every row is throttled", () => {
    expect(canRetryAny([row(minutesAgo(1)), row(minutesAgo(2))])).toBe(false);
  });

  // An empty group means there is nothing the button could queue, so it must not offer to.
  it("blocks a retry for an empty group", () => {
    expect(canRetryAny([])).toBe(false);
  });
});
