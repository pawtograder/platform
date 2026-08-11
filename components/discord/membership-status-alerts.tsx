"use client";

import { Alert } from "@/components/ui/alert";
import DiscordReinviteButton from "@/components/discord/reinvite-button";
import { useDiscordMembershipStatus, type DiscordMembershipRow } from "@/hooks/useDiscordMembershipStatus";
import { Box, List, Stack, Text } from "@chakra-ui/react";

/** How many names to spell out before falling back to a count. */
const NAMES_SHOWN = 10;

function describe(row: DiscordMembershipRow): string {
  const name = row.name ?? row.email ?? "Unknown student";
  return row.discord_username ? `${name} (@${row.discord_username})` : name;
}

/** Discord error codes that mean the bot lacks a permission, as opposed to being misconfigured. */
const PERMISSION_ERROR_CODES = new Set([50001, 50013]);

/**
 * What an instructor should actually do about a `cannot_invite` row.
 *
 * `cannot_invite` covers every terminal invite failure, not just permission ones — Unknown Guild
 * (10004) usually means the configured server ID is wrong, and no amount of granting permissions will
 * fix that. Telling an instructor to change permissions in that case sends them at the wrong problem,
 * so the wording follows the recorded code.
 */
function remediationFor(row: DiscordMembershipRow): string {
  const code = row.discord_error_code;

  if (code === 10004) {
    return "Discord does not recognize this server, so the server ID in the Discord settings is probably wrong or the bot is no longer a member of it. Check the Discord integration settings for this course.";
  }
  if (code === 10003) {
    return "The channel the bot tried to invite through no longer exists. Check the Discord integration settings for this course.";
  }
  // Checked before the null-code branch below. A guild with no text channel is reported by the
  // wrapper after a *successful* channel listing, so there is no HTTP status or JSON code to record
  // and the row lands with a null code -- but the bot's permissions are already correct, and telling
  // an admin to grant channel access would send them to fix something that is not broken.
  if (row.detail?.includes("No text channels found in guild")) {
    return "The bot can read this server but it has no text channel to create an invite in. Add a text channel to the Discord server.";
  }
  if (code === null || code === undefined || PERMISSION_ERROR_CODES.has(code)) {
    return "The bot needs permission to view the server's channels before it can create invites, so these students cannot join until a Discord server admin grants it.";
  }
  return "This is a configuration problem rather than a missing permission, so granting the bot more access will not resolve it. The error above names the cause.";
}

/**
 * Split `cannot_invite` rows by the cause recorded against them.
 *
 * `cannot_invite` is one state covering every terminal invite failure, so one class can hold rows
 * with different causes at once — a wrong server ID for the guild the class moved off, a missing
 * permission on the one it moved to. Reporting the first row's cause for all of them would name a
 * remediation that is wrong for everyone else in the list.
 */
function groupByCause(rows: DiscordMembershipRow[]): { code: number | null; rows: DiscordMembershipRow[] }[] {
  const groups = new Map<number | null, DiscordMembershipRow[]>();
  for (const row of rows) {
    const code = row.discord_error_code ?? null;
    const existing = groups.get(code);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(code, [row]);
    }
  }
  return [...groups.entries()]
    .map(([code, groupRows]) => ({ code, rows: groupRows }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

function StudentList({ rows }: { rows: DiscordMembershipRow[] }) {
  const shown = rows.slice(0, NAMES_SHOWN);
  const remaining = rows.length - shown.length;

  return (
    <Box mt={2}>
      <List.Root fontSize="sm" pl={4}>
        {shown.map((row) => (
          <List.Item key={row.user_id}>{describe(row)}</List.Item>
        ))}
      </List.Root>
      {remaining > 0 && (
        <Text fontSize="sm" color="fg.muted" mt={1}>
          and {remaining} more
        </Text>
      )}
    </Box>
  );
}

/**
 * Discord enrollment problems an instructor can act on.
 *
 * The two states are deliberately different in tone. A student who has not joined the server is
 * ordinary and resolves itself when they use their invite, so it is a warning with a roster to work
 * from. A bot that cannot create invites blocks every one of those students and only a Discord admin
 * can clear it, so it is an error.
 *
 * Renders nothing when there is nothing to act on.
 */
export default function DiscordMembershipStatusAlerts({ classId }: { classId: number | undefined }) {
  const { notJoined, cannotInvite, loading, error, refresh } = useDiscordMembershipStatus(classId);

  if (loading || error) {
    // A failure to read this is not itself actionable for an instructor, and the roster it sits above
    // is still usable, so it stays quiet.
    return null;
  }

  if (notJoined.length === 0 && cannotInvite.length === 0) {
    return null;
  }

  const stuck = cannotInvite.length + notJoined.length;

  return (
    <Stack gap={3} mb={4}>
      {groupByCause(cannotInvite).map(({ code, rows }) => (
        <Alert
          key={code ?? "none"}
          status="error"
          title={`The Discord bot cannot invite ${rows.length} ${rows.length === 1 ? "student" : "students"}`}
        >
          <Text>
            Discord refused the invite with{" "}
            <Text as="span" fontFamily="mono">
              {rows[0].detail ?? "an error"}
            </Text>
            . {remediationFor(rows[0])} Until then their Pawtograder roles will not appear in Discord.
          </Text>
          <StudentList rows={rows} />
        </Alert>
      ))}

      {notJoined.length > 0 && (
        <Alert
          status="warning"
          title={`${notJoined.length} ${notJoined.length === 1 ? "student has" : "students have"} not joined the Discord server`}
        >
          <Text>
            Each has an invite waiting. Their roles sync automatically once they join — no action is needed unless you
            want to remind them.
          </Text>
          <StudentList rows={notJoined} />
        </Alert>
      )}

      {/*
       * One button rather than one per alert, because the retry is not scoped: it re-checks everyone
       * in the class who is not recorded as being in the server. A button inside the cannot_invite
       * alert reading "retry these 3" would queue all twelve, so the label states the real scope.
       *
       * This is the only thing that clears a cannot_invite row. The hourly sync is what recorded it,
       * and for a class past its end date that sync no longer runs -- so without this an instructor
       * who has just fixed the bot's permissions has a red alert and nothing to press. It also covers
       * an expired invite, which leaves a student listed as not joined with a dead link.
       */}
      {classId !== undefined && (
        <Box>
          <DiscordReinviteButton
            classId={classId}
            rows={[...cannotInvite, ...notJoined]}
            label={`Retry Discord for ${stuck} ${stuck === 1 ? "student" : "students"}`}
            onQueued={refresh}
          />
        </Box>
      )}
    </Stack>
  );
}
