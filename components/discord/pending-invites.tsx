"use client";

import { Box, Button, Heading, HStack, Icon, Stack, Text, VStack } from "@chakra-ui/react";
import { BsDiscord, BsExclamationCircle } from "react-icons/bs";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useRef, useState } from "react";
import { Alert } from "../ui/alert";
import { Tooltip } from "../ui/tooltip";
import useAuthState from "@/hooks/useAuthState";

type DiscordInvite = {
  id: number;
  user_id: string;
  class_id: number;
  guild_id: string;
  invite_code: string;
  invite_url: string;
  expires_at: string;
  used: boolean;
  created_at: string;
  classes?: {
    id: number;
    slug: string | null;
    name: string | null;
    discord_server_id: string | null;
  };
};

type PendingInvitesProps = {
  classId?: number; // If provided, only show invites for this class
  showAll?: boolean; // If true, show all invites (for staff view)
};

export default function PendingInvites({ classId, showAll = false }: PendingInvitesProps) {
  const { user } = useAuthState();
  const [invites, setInvites] = useState<DiscordInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    const fetchInvites = async () => {
      setLoading(true);
      setError(null);
      const supabase = createClient();

      try {
        let query = supabase
          .from("discord_invites")
          .select("*, classes(id, slug, name, discord_server_id)")
          .eq("used", false)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false });

        if (!showAll) {
          // Only show invites for current user
          query = query.eq("user_id", user.id);
        }

        if (classId) {
          query = query.eq("class_id", classId);
        }

        const { data, error: fetchError } = await query;

        if (fetchError) throw fetchError;

        // Only invites into the server the class currently uses. discord_invites is keyed on
        // guild_id but nothing clears rows when a course changes or unsets discord_server_id, so an
        // old unused invite stays here and would be offered under the current course's name --
        // sending a student into a server the class has moved off, where the membership sync will
        // go on reporting them absent because it only ever looks at the current guild.
        const current = ((data || []) as DiscordInvite[]).filter(
          (invite) => invite.classes?.discord_server_id && invite.guild_id === invite.classes.discord_server_id
        );
        setInvites(current);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Error fetching Discord invites:", err);
        setError(err instanceof Error ? err.message : "Failed to load invites");
      } finally {
        setLoading(false);
      }
    };

    fetchInvites();

    // Refresh every 30 seconds to check for new invites
    const interval = setInterval(fetchInvites, 30000);
    return () => clearInterval(interval);
  }, [user, classId, showAll]);

  // Landing here with an invite still outstanding asks for the roles to be provisioned.
  //
  // An unused invite row IS the "not provisioned yet" signal: `mark_discord_invite_used` runs in the
  // same worker step that adds the roles, so a row still at `used = false` means the worker has not
  // yet seen this student in the guild. Nothing re-checks that promptly on its own --
  // `discord-batch-role-sync-hourly` is `0 * * * *`, and discord-reconciler only repairs a sync that
  // has stopped running, treating `not_joined` as normal -- so a student who joins a minute after
  // their invite is minted would otherwise wait for the next hour boundary. That is the wait the
  // panel's old "within an hour" copy and its sync button described; this replaces both.
  //
  // request_discord_reinvite enqueues exactly the work the hourly batch would, and is already the
  // student-facing half of that RPC: it permits a caller to retry their OWN membership, verifies the
  // enrollment, throttles to one retry per user per five minutes in SQL, and takes a class-scoped
  // advisory lock. So this needs no new state and cannot be used to enqueue work for anyone else.
  //
  // Fired once per mount rather than on every 30s poll: the SQL throttle makes repeats harmless but
  // not free, and one request per visit is all it takes to close the gap.
  const provisionRequested = useRef(false);
  useEffect(() => {
    if (showAll || !user || !classId) return;
    if (invites.length === 0 || provisionRequested.current) return;
    provisionRequested.current = true;

    createClient()
      .rpc("request_discord_reinvite", { p_class_id: classId, p_user_id: user.id })
      .then(({ error: rpcError }) => {
        if (rpcError) {
          // Deliberately not surfaced. The hourly sync still covers this student, so a failure here
          // costs them time rather than correctness, and an error banner on a panel whose whole
          // message is "this is being handled" would be worse than the delay.
          // eslint-disable-next-line no-console
          console.warn("Discord role provisioning request failed:", rpcError);
        }
      });
  }, [invites.length, showAll, user, classId]);

  // Only the first fetch, not the 30-second background refresh. `loading` goes true on every poll,
  // so reacting to it unconditionally tore the whole panel down and rebuilt it twice a minute --
  // taking the join and copy buttons with it, and cancelling any interaction in progress. While
  // there are cached invites to show, the refresh is invisible.
  if (loading && invites.length === 0) {
    // Silent for the student view, which resolves to nothing for most students: a placeholder there
    // would flash "Loading Discord invites..." on every dashboard load. The staff listing is a
    // section someone navigated to on purpose, so it says what it is doing.
    if (!showAll) return null;
    return (
      <Box p={4}>
        <Text fontSize="sm" color="fg.muted">
          Loading Discord invites...
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Alert status="error" title="Error loading invites">
        {error}
      </Alert>
    );
  }

  if (invites.length === 0) {
    // Nothing to show. A student who has just linked has their add_member_role envelope already in
    // flight -- trg_update_discord_profile_on_insert enqueues it on the link itself -- so this is a
    // gap of one worker poll rather than something needing its own explanatory panel.
    return null;
  }

  return (
    <Box borderWidth="1px" borderRadius="md" p={4} bg="bg.info">
      <VStack align="stretch" gap={3}>
        <HStack>
          <Icon as={BsDiscord} size="lg" />
          <Heading size="md">Discord Server Invites</Heading>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          {showAll
            ? "Users who need to join Discord servers for their classes:"
            : "You need to join these Discord servers to receive notifications:"}
        </Text>
        <Stack gap={2}>
          {invites.map((invite) => {
            const expiresAt = new Date(invite.expires_at);
            const isExpiringSoon = expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000; // Less than 24 hours
            const classInfo = invite.classes;

            return (
              <Box
                key={invite.id}
                borderWidth="1px"
                borderRadius="md"
                p={3}
                bg="bg.surface"
                borderColor={isExpiringSoon ? "border.warning" : "border.subtle"}
              >
                <VStack align="stretch" gap={2}>
                  <HStack justify="space-between">
                    <VStack align="start" gap={0}>
                      {classInfo && (
                        <Text fontWeight="semibold" fontSize="sm">
                          {classInfo.name || classInfo.slug || `Class ${invite.class_id}`}
                        </Text>
                      )}
                      {!classInfo && (
                        <Text fontWeight="semibold" fontSize="sm">
                          Class {invite.class_id}
                        </Text>
                      )}
                      <Text fontSize="xs" color="fg.muted">
                        Expires {expiresAt.toLocaleDateString()} at {expiresAt.toLocaleTimeString()}
                      </Text>
                    </VStack>
                    {isExpiringSoon && (
                      <Tooltip content="Expiring soon">
                        <Icon as={BsExclamationCircle} color="fg.warning" />
                      </Tooltip>
                    )}
                  </HStack>
                  <HStack gap={2}>
                    <Button asChild colorPalette="blue" size="sm">
                      <a href={invite.invite_url} target="_blank" rel="noopener noreferrer">
                        <Icon as={BsDiscord} />
                        <Text>Join Discord Server</Text>
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(invite.invite_url);
                      }}
                    >
                      Copy Link
                    </Button>
                  </HStack>
                </VStack>
              </Box>
            );
          })}
        </Stack>
        <Box borderTopWidth="1px" pt={3} mt={1}>
          <VStack align="stretch" gap={2}>
            <Text fontSize="xs" color="fg.muted">
              <strong>After joining the Discord server:</strong>
            </Text>
            {/* No timing promise and no self-service sync control, because the effect above now does
                what the button did: landing here with an invite outstanding enqueues the role sync
                directly, and the worker drains that queue every minute. The student no longer has to
                find and press anything for the common case, so "shortly" is a claim the page keeps
                rather than one that depended on them noticing a control.

                The cases the button could not fix are unchanged and still need an instructor -- the
                bot missing Manage Roles, or its role sitting below the course roles -- which is what
                the second sentence is for. A student who joins and never returns to this page falls
                back to the hourly batch sync, as before. */}
            <Text fontSize="xs" color="fg.muted">
              Your course roles will be assigned shortly. If they don&apos;t appear, contact your instructors.
            </Text>
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
