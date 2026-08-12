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
function groupByCause(rows: DiscordMembershipRow[]): { key: string; rows: DiscordMembershipRow[] }[] {
  // Keyed on the remediation, not the Discord code. Several terminal failures carry no JSON code at
  // all -- a 403 whose body did not parse, and "No text channels found in guild", which the wrapper
  // reports after a *successful* channel listing -- so grouping by code put them together under
  // null and gave the whole group one row's advice. That is how an instructor gets told to add a
  // text channel for students whose actual problem is a missing permission. Rows that need the same
  // action now group together whatever code they carry.
  const groups = new Map<string, DiscordMembershipRow[]>();
  for (const row of rows) {
    const key = remediationFor(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => ({ key, rows: groupRows }))
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
export default function DiscordMembershipStatusAlerts({
  classId,
  /**
   * Keep the retry control on screen when there is nothing to report.
   *
   * The retry also re-creates a class's missing Discord roles, and that repair is deliberately
   * independent of anyone's membership: the batch records `in_guild` even when the role sync
   * silently finds no role, so a class whose role creation failed can have a perfectly healthy
   * roster and no roles at all. With the button living inside the alerts, that is exactly the case
   * with no way to reach it. Set on the Discord settings page, where a control that is occasionally
   * a no-op is appropriate; left off the roster, where it would be permanent furniture.
   */
  alwaysOfferRetry = false
}: {
  classId: number | undefined;
  alwaysOfferRetry?: boolean;
}) {
  const { notJoined, cannotInvite, byUserId, loading, error, refresh } = useDiscordMembershipStatus(classId);

  if (loading || error) {
    // A failure to read this is not itself actionable for an instructor, and the roster it sits above
    // is still usable, so it stays quiet.
    return null;
  }

  if (notJoined.length === 0 && cannotInvite.length === 0) {
    if (!alwaysOfferRetry || classId === undefined) {
      return null;
    }
    // An empty result has two meanings and they must not be conflated. Rows present and none of them
    // a problem is a real all-clear; no rows at all means the sync has not looked -- a newly
    // configured class before its first pass, or one outside the active-class window, where nothing
    // will ever create them. Saying "every linked student is in the server" there would present an
    // absence of observations as confirmed membership, the same guess the roster column exists to
    // avoid, and the retry RPC treats those users as eligible precisely because they are unchecked.
    const nothingChecked = byUserId.size === 0;
    return (
      <Box mb={4}>
        <Text fontSize="sm" color="fg.muted">
          {nothingChecked
            ? "No Discord membership has been checked for this course yet. Retrying checks every linked student and re-creates the course's Discord roles if they are missing."
            : "No Discord membership problems are recorded for this course. If roles are missing in the server, retrying re-creates them."}
        </Text>
        <DiscordReinviteButton classId={classId} rows={[]} label="Retry Discord setup" onQueued={refresh} />
      </Box>
    );
  }

  const stuck = cannotInvite.length + notJoined.length;

  return (
    <Stack gap={3} mb={4}>
      {groupByCause(cannotInvite).map(({ key, rows }) => (
        <Alert
          key={key}
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
            Each has an invite waiting on their course dashboard, and their roles sync automatically once they use it —
            no action is needed unless you want to remind them.
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
