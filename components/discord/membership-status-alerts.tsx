"use client";

import { Alert } from "@/components/ui/alert";
import { useDiscordMembershipStatus, type DiscordMembershipRow } from "@/hooks/useDiscordMembershipStatus";
import { Box, List, Stack, Text } from "@chakra-ui/react";

/** How many names to spell out before falling back to a count. */
const NAMES_SHOWN = 10;

function describe(row: DiscordMembershipRow): string {
  const name = row.name ?? row.email ?? "Unknown student";
  return row.discord_username ? `${name} (@${row.discord_username})` : name;
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
  const { notJoined, cannotInvite, loading, error } = useDiscordMembershipStatus(classId);

  if (loading || error) {
    // A failure to read this is not itself actionable for an instructor, and the roster it sits above
    // is still usable, so it stays quiet.
    return null;
  }

  if (notJoined.length === 0 && cannotInvite.length === 0) {
    return null;
  }

  return (
    <Stack gap={3} mb={4}>
      {cannotInvite.length > 0 && (
        <Alert
          status="error"
          title={`The Discord bot cannot invite ${cannotInvite.length} ${cannotInvite.length === 1 ? "student" : "students"}`}
        >
          <Text>
            Discord refused the invite with{" "}
            <Text as="span" fontFamily="mono">
              {cannotInvite[0].detail ?? "a permissions error"}
            </Text>
            . The bot needs permission to view the server&apos;s channels before it can create invites, so these
            students cannot join until a Discord server admin grants it. Until then their Pawtograder roles will not
            appear in Discord.
          </Text>
          <StudentList rows={cannotInvite} />
        </Alert>
      )}

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
    </Stack>
  );
}
