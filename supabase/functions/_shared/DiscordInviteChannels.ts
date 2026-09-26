/**
 * Which channel a guild invite should be created in, and in what order to try them.
 *
 * Discord layers per-channel and per-category permission overwrites on top of the guild-level
 * bitfield, and the two failure modes look nothing alike from the outside:
 *
 *   VIEW_CHANNEL denied           the channel is absent from GET /guilds/{id}/channels entirely
 *   CREATE_INSTANT_INVITE denied  the channel is listed, and POST /channels/{id}/invites 403s (50013)
 *
 * The first is invisible and needs no handling. The second is a trap, because the listing is in no
 * useful order and the channel that happens to come back first is as likely as any other to be the
 * one an admin locked down. Invites are how students enroll -- there is no guilds.join fallback on
 * this branch -- so one denied channel used to block every student in the class from joining a server
 * whose other channels would have accepted the same request.
 *
 * This module decides the candidate order. It is pure and free of Deno, Sentry and fetch so it can be
 * unit-tested directly, and so the frontend can import the marker string below rather than repeat it.
 *
 * Run from supabase/functions:  deno test --no-check _shared/DiscordInviteChannels.test.ts
 */

/** Discord channel types. Full list: https://discord.com/developers/docs/resources/channel */
export const GUILD_TEXT = 0;
export const GUILD_ANNOUNCEMENT = 5;

/**
 * How many channels an invite attempt is allowed to try.
 *
 * Every attempt is a real POST against the guild's invite bucket, paid once per student, so the bound
 * is a rate-limit decision more than a correctness one: a 400-channel guild that denies the bot
 * everywhere would otherwise cost 400 requests per enrolled student before reporting the failure an
 * admin has to fix anyway. Four is enough for the case this exists for, where a locked-down landing
 * channel sits in front of an ordinary one, and cheap enough that the hopeless guild still reports
 * quickly. A guild that needs a fifth candidate has a permission problem, not a channel problem.
 */
export const MAX_INVITE_CHANNEL_ATTEMPTS = 4;

/**
 * The two invite failures, kept here because both strings are matched elsewhere.
 *
 * They are separate because the remediations are opposites: one asks an instructor to add a channel,
 * the other asks a Discord admin to grant a permission on a channel that already exists. Sending
 * someone at the wrong one costs a support round trip.
 *
 * NO_TEXT_CHANNEL_MESSAGE is the original wording and must stay exactly this, character for
 * character: classifyDiscordError, isBotPermissionProblem and remediationFor in
 * components/discord/membership-status-alerts.tsx all match it as a substring of a stored
 * discord_membership_status.detail, including rows written before this change.
 */
export const NO_TEXT_CHANNEL_MESSAGE = "No text channels found in guild";
export const ALL_CHANNELS_REFUSED_INVITE = "Every candidate channel refused invite creation";

/** A channel an invite could be created in. `name` is carried for the error message and the logs. */
export type InviteCandidate = {
  id: string;
  name: string;
};

/**
 * Channel names that suggest a room a newcomer is meant to land in, best first.
 *
 * This ordering is user-visible, not just a fallback: an invite drops the student directly into the
 * channel it was created for, so the choice decides what the first thing they see is. A welcome or
 * general channel is where a course puts its orientation; #staff-only or #assignment-3-grading is
 * where the previous behavior could just as easily have put them.
 *
 * Matched as a substring of the lowercased name so decorated names ("welcome-here", an emoji prefix)
 * still hit. Deliberately short: every entry is a guess about a channel's purpose, and a long list of
 * guesses is harder to predict than the position order it overrides.
 */
const PREFERRED_NAME_HINTS = ["welcome", "start-here", "general", "lobby", "main"] as const;

type RawChannel = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  position?: unknown;
};

type RankedCandidate = InviteCandidate & {
  nameRank: number;
  typeRank: number;
  position: number;
};

function nameRankOf(name: string): number {
  const lowered = name.toLowerCase();
  const index = PREFERRED_NAME_HINTS.findIndex((hint) => lowered.includes(hint));
  return index === -1 ? PREFERRED_NAME_HINTS.length : index;
}

/**
 * Snowflakes are decimal integers wider than Number can hold exactly, so they are compared as
 * numeric strings: shorter is smaller, and equal lengths compare lexicographically.
 */
function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A total order, so the same guild always yields the same first candidate.
 *
 * Position is what an admin arranged and is the honest default once the name hints are exhausted. The
 * id tiebreak is what makes the order total: Discord permits two channels to share a position, and
 * without it the result would fall back on listing order, which is the arbitrariness this module
 * exists to remove.
 */
function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.nameRank !== b.nameRank) return a.nameRank - b.nameRank;
  if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
  if (a.position !== b.position) return a.position - b.position;
  return compareSnowflakes(a.id, b.id);
}

/**
 * The channels an invite may be created in, best candidate first.
 *
 * Takes the parsed body of GET /guilds/{id}/channels as-is, including a non-array body, because the
 * caller has no schema for it and a malformed listing should read as "no candidates" rather than
 * throw something a caller cannot classify.
 *
 * Type 0 and type 5 are both accepted. An announcement channel is a text channel with a different
 * publishing model, POST /channels/{id}/invites works on it, and a student who lands there can still
 * see the server. It sorts after every plain text channel anyway, because announcement channels are
 * normally read-only for members and a room nobody can reply in is a poor first impression. Excluded
 * are categories (4), which cannot hold an invite; threads (10, 11, 12), which Discord refuses
 * outright; and voice and stage channels (2, 13), where an invite opens a live call rather than a
 * page of text. Forums (15) are left out for the same reason as voice: the invite lands somewhere a
 * newcomer cannot read as a conversation.
 */
export function inviteCandidateChannels(channels: unknown): InviteCandidate[] {
  if (!Array.isArray(channels)) return [];

  const ranked: RankedCandidate[] = [];
  for (const raw of channels as RawChannel[]) {
    if (raw === null || typeof raw !== "object") continue;
    if (raw.type !== GUILD_TEXT && raw.type !== GUILD_ANNOUNCEMENT) continue;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;

    const name = typeof raw.name === "string" ? raw.name : "";
    ranked.push({
      id: raw.id,
      name,
      nameRank: nameRankOf(name),
      typeRank: raw.type === GUILD_TEXT ? 0 : 1,
      // A channel with no usable position sorts after those that have one instead of ahead of them,
      // which is what a missing field would do if it were read as 0.
      position:
        typeof raw.position === "number" && Number.isFinite(raw.position) ? raw.position : Number.MAX_SAFE_INTEGER
    });
  }

  ranked.sort(compareCandidates);
  return ranked.map(({ id, name }) => ({ id, name }));
}

/** How a candidate is named in an error message: `#general (140...1)`, or just the id if unnamed. */
export function describeCandidate(candidate: InviteCandidate): string {
  return candidate.name ? `#${candidate.name} (${candidate.id})` : candidate.id;
}
