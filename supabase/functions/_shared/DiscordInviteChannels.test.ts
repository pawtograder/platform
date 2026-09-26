/**
 * Unit tests for invite candidate selection.
 *
 * The channel objects below are shaped the way Discord's GET /guilds/{id}/channels returns them,
 * because that body is what the helper is handed straight out of `response.json()`. The ordering
 * assertions are the point of the file: which channel comes first is what a student sees when they
 * use their invite, so a change in that order is a change in behavior and should fail here.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordInviteChannels.test.ts
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  ALL_CHANNELS_REFUSED_INVITE,
  describeCandidate,
  inviteCandidateChannels,
  MAX_INVITE_CHANNEL_ATTEMPTS,
  NO_TEXT_CHANNEL_MESSAGE
} from "./DiscordInviteChannels.ts";

type Channel = { id: string; name: string; type: number; position?: number; parent_id?: string | null };

function channel(id: string, name: string, type: number, position: number): Channel {
  return { id, name, type, position, parent_id: null };
}

/** Ids only, which is what the caller uses; the names are asserted separately where they matter. */
function idsOf(channels: unknown): string[] {
  return inviteCandidateChannels(channels).map((candidate) => candidate.id);
}

Deno.test("inviteCandidateChannels: an empty guild yields no candidates", () => {
  assertEquals(inviteCandidateChannels([]), []);
});

Deno.test("inviteCandidateChannels: a body that is not an array yields no candidates", () => {
  // The caller has no schema for the parsed body. Reading a malformed one as "nothing to try" keeps
  // the failure on the no-channel path, which is classified and worded, instead of a TypeError.
  assertEquals(inviteCandidateChannels(null), []);
  assertEquals(inviteCandidateChannels({ message: "Missing Access", code: 50001 }), []);
});

Deno.test("inviteCandidateChannels: a category is not a candidate", () => {
  // Type 4 holds other channels and cannot hold an invite. This is the guild that produces the
  // "no text channels" message rather than a permission one.
  assertEquals(inviteCandidateChannels([channel("100", "pawtograder", 4, 0)]), []);
});

Deno.test("inviteCandidateChannels: voice, stage and thread channels are not candidates", () => {
  const channels = [
    channel("100", "Lecture", 2, 0),
    channel("101", "Office Hours Stage", 13, 1),
    channel("102", "help-thread", 11, 2)
  ];
  // A voice invite opens a live call rather than anything readable, and Discord refuses invites on
  // threads outright.
  assertEquals(inviteCandidateChannels(channels), []);
});

Deno.test("inviteCandidateChannels: a single text channel is the only candidate", () => {
  const candidates = inviteCandidateChannels([channel("100", "pawtograder", 4, 0), channel("101", "chat", 0, 1)]);
  assertEquals(candidates, [{ id: "101", name: "chat" }]);
});

Deno.test("inviteCandidateChannels: several text channels come back in position order", () => {
  const channels = [
    channel("103", "assignments", 0, 3),
    channel("101", "chat", 0, 1),
    channel("102", "questions", 0, 2)
  ];
  // Listing order is deliberately wrong here: position is what an admin arranged, so it wins.
  assertEquals(idsOf(channels), ["101", "102", "103"]);
});

Deno.test("inviteCandidateChannels: a welcome channel outranks an earlier-positioned one", () => {
  const channels = [channel("101", "assignment-3-grading", 0, 1), channel("102", "welcome", 0, 9)];
  // The name preference exists because an invite drops the student into the channel it names. Landing
  // in #welcome from position 9 is better than landing in a grading channel that happens to be first.
  assertEquals(idsOf(channels), ["102", "101"]);
});

Deno.test("inviteCandidateChannels: name hints are ranked against each other, not just present", () => {
  const channels = [channel("101", "general", 0, 1), channel("102", "🎉-welcome-here", 0, 8)];
  // Both names hint at a landing place. "welcome" is the stronger hint and the decorated name still
  // matches, since the hints are checked as substrings of the lowercased name.
  assertEquals(idsOf(channels), ["102", "101"]);
});

Deno.test("inviteCandidateChannels: an announcement channel sorts after every plain text channel", () => {
  const channels = [channel("101", "announcements", 5, 0), channel("102", "questions", 0, 7)];
  // Type 5 accepts an invite, so it stays a candidate, but it is normally read-only for members and a
  // room nobody can reply in is a poor first impression. Position 0 does not rescue it.
  assertEquals(idsOf(channels), ["102", "101"]);
});

Deno.test("inviteCandidateChannels: a name hint outranks the text-before-announcement preference", () => {
  const channels = [channel("101", "welcome", 5, 4), channel("102", "questions", 0, 1)];
  // The hint is about where the student should land; the type is only a guess about how usable the
  // channel is. A channel actually named "welcome" is the better answer either way.
  assertEquals(idsOf(channels), ["101", "102"]);
});

Deno.test("inviteCandidateChannels: channels sharing a position are ordered by id", () => {
  const channels = [channel("205", "questions", 0, 2), channel("204", "chat", 0, 2)];
  // Discord permits duplicate positions. Without the id tiebreak the order would follow the listing,
  // which is not stable between calls, and the invite would land somewhere different each run.
  assertEquals(idsOf(channels), ["204", "205"]);
  assertEquals(idsOf([...channels].reverse()), ["204", "205"]);
});

Deno.test("inviteCandidateChannels: ids are compared as numbers, not as strings", () => {
  // Snowflakes are too wide for Number, so they are compared by length then lexicographically. Plain
  // string comparison would put the shorter, older id second.
  const channels = [channel("1400000000000000010", "b", 0, 0), channel("999999999999999999", "a", 0, 0)];
  assertEquals(idsOf(channels), ["999999999999999999", "1400000000000000010"]);
});

Deno.test("inviteCandidateChannels: a channel with no position sorts after channels that have one", () => {
  const channels = [{ id: "101", name: "chat", type: 0 }, channel("102", "questions", 0, 5)];
  assertEquals(idsOf(channels), ["102", "101"]);
});

Deno.test("inviteCandidateChannels: entries without a usable id are dropped", () => {
  const channels = [{ name: "chat", type: 0 }, { id: 101, name: "questions", type: 0 }, channel("102", "help", 0, 1)];
  assertEquals(idsOf(channels), ["102"]);
});

Deno.test("describeCandidate: names the channel, and falls back to the bare id", () => {
  assertEquals(describeCandidate({ id: "101", name: "general" }), "#general (101)");
  assertEquals(describeCandidate({ id: "101", name: "" }), "101");
});

Deno.test("the two failure markers stay distinct, and the old one stays verbatim", () => {
  // Both are matched as substrings of a stored discord_membership_status.detail, including rows
  // written before the fallback existed. If the markers ever overlapped, or the old one were reworded,
  // every "no text channel" row would silently take the wrong remediation.
  assertEquals(NO_TEXT_CHANNEL_MESSAGE, "No text channels found in guild");
  assertEquals(ALL_CHANNELS_REFUSED_INVITE.includes(NO_TEXT_CHANNEL_MESSAGE), false);
  assertEquals(NO_TEXT_CHANNEL_MESSAGE.includes(ALL_CHANNELS_REFUSED_INVITE), false);
});

Deno.test("the attempt cap is small enough to bound a hostile guild", () => {
  // Each attempt is a POST paid once per enrolled student, so this is a rate-limit bound. Asserted so
  // raising it is a deliberate edit rather than a drift.
  assertEquals(MAX_INVITE_CHANNEL_ATTEMPTS, 4);
});
