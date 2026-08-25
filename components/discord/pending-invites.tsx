"use client";

import { Box, Button, Heading, HStack, Icon, Stack, Text, VStack } from "@chakra-ui/react";
import { BsDiscord, BsExclamationCircle } from "react-icons/bs";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useRef, useState } from "react";
import { Alert } from "../ui/alert";
import { Tooltip } from "../ui/tooltip";
import useAuthState from "@/hooks/useAuthState";
import RequestRoleSyncButton from "./request-role-sync-button";

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

  // Coming BACK to this page with an invite still outstanding asks for the roles to be provisioned.
  //
  // An unused invite row is the "not provisioned yet" signal: `mark_discord_invite_used` runs in the
  // same worker step that adds the roles, so a row still at `used = false` means the worker has not
  // yet seen this student in the guild. Nothing re-checks that promptly on its own --
  // `discord-batch-role-sync-hourly` is `0 * * * *`, and discord-reconciler only repairs a sync that
  // has stopped running, treating `not_joined` as normal -- so a student who joins a minute after
  // their invite is minted would otherwise wait for the next hour boundary. That is the wait the
  // panel's old "within an hour" copy described, and the wait its sync button existed to escape.
  // This removes the need to press anything for the common case; the button below remains for the
  // case no event can announce.
  //
  // Nothing is requested on mount, and that omission is load-bearing twice over.
  //
  // The join opens discord.gg in a NEW TAB, so this dashboard stays mounted throughout: a mount
  // request goes out while the student is still absent, the worker takes its "no role to add" exit,
  // and the moment that would actually succeed -- their return -- has already been spent. Worse, it
  // poisons the retry. By the time an invite can render here the worker has already written the
  // student's `not_joined` row (recordMembershipStatus runs immediately after storing the invite), so
  // a mount request always finds a row to stamp last_retry_requested_at on, and the RPC's five-minute
  // predicate then rejects the request made on return. Asking eagerly would disable the handler below.
  //
  // Returning to this tab is the only observable "the student has joined" signal available, so it is
  // the only thing that triggers a request -- but only after they have actually opened an invite.
  //
  // Arming on the join click is what keeps this off the student's retry budget. Listening to every
  // focus event meant an ordinary return to the dashboard -- another tab, lunch, a different window --
  // enqueued a pre-join check and, since the same RPC now carries a five-a-day cap, spent one of the
  // five. Five idle tab switches and the return that followed the real join was refused, and so was
  // the manual button: the automatic path would have eaten the recourse it was meant to supplement.
  //
  // So the handler is armed by opening an invite and disarmed by firing. One join click buys one
  // automatic check, which is proportionate -- it is the student's own deliberate action, and it is
  // the action whose completion this is watching for.
  //
  // The cost of that restraint: a student who joined earlier, was never provisioned, and loads this
  // page without ever leaving and returning to it gets no automatic request. That is what the button
  // below is for, and failing that the hourly batch, which is the behaviour before any of this.
  //
  // request_discord_reinvite enqueues exactly the work the hourly batch would, and is already the
  // student-facing half of that RPC: it permits a caller to retry their OWN membership, verifies the
  // enrollment, throttles to one retry per user per five minutes in SQL, and takes a class-scoped
  // advisory lock. So this cannot be used to enqueue work for anyone else.
  const invitesOutstanding = invites.length > 0;
  // A ref, not state: opening the invite must not re-render the panel mid-click, and the listeners
  // below read it when they fire rather than closing over a stale value.
  const joinOpened = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (showAll || !user || !classId || !invitesOutstanding) return;

    const fire = () => {
      joinOpened.current = false;
      createClient()
        .rpc("request_discord_reinvite", { p_class_id: classId, p_user_id: user.id })
        .then(({ data, error: rpcError }) => {
          if (rpcError) {
            // Deliberately not surfaced. The hourly sync and the button below both still cover this
            // student, so a failure here costs them time rather than correctness, and an error banner
            // on a panel whose whole message is "this is being handled" would be worse than the delay.
            // eslint-disable-next-line no-console
            console.warn("Discord role provisioning request failed:", rpcError);
            return;
          }
          // Queued nothing, which here almost always means the five-minute throttle: the student
          // pressed the button below shortly before joining, so the check that actually matters is
          // the one being refused. Retry once the window has passed rather than handing them to the
          // hourly batch -- the join has already happened, so this is not a speculative request.
          //
          // On a timer that calls `fire` directly rather than re-arming, because re-arming would wait
          // for another focus event and a student who joins and then stays on this page never
          // produces one.
          if ((data?.[0]?.queued ?? 0) === 0) {
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(fire, 5 * 60 * 1000 + 15_000);
          }
        });
    };

    const onReturn = () => {
      if (joinOpened.current) fire();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    document.addEventListener("visibilitychange", onVisible);
    // `focus` as well as visibilitychange: returning from a new tab fires visibilitychange, but
    // returning from another WINDOW (a desktop Discord client taking focus, say) only fires focus.
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onReturn);
      // The panel unmounts as soon as the invite is marked used, which is the success case, so a
      // pending retry has to be dropped rather than left to fire into a dead component.
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [invitesOutstanding, showAll, user, classId]);

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
                      {/* Opening the invite is what arms the return handler above. Without this the
                          handler would fire on any return to the dashboard and spend the student's
                          daily retry budget on checks made while they were never in Discord. */}
                      <a
                        href={invite.invite_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => (joinOpened.current = true)}
                      >
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
            {/* No timing promise, because the effect above makes the common case genuinely prompt:
                returning to this page with an invite outstanding enqueues the role sync, and the
                worker drains that queue every minute. The old copy's "within an hour" described the
                batch fallback, which is now the exception rather than the path everyone takes.

                The button stays for the case the automatic path cannot observe -- a student who
                joined and then never left and re-entered this page, so no visibility or focus event
                ever fires. Unlike the control it replaces it is rationed: five presses a day, out of
                request_discord_reinvite rather than out of the unthrottled
                trigger_discord_role_sync_for_user, because Discord's rate limits are per-bot and one
                student holding a button spends them for every class. */}
            <Text fontSize="xs" color="fg.muted">
              Your course roles will be assigned shortly. If they don&apos;t appear, use the button below, then contact
              your instructors if they still don&apos;t.
            </Text>
            {!showAll && classId && user && <RequestRoleSyncButton classId={classId} userId={user.id} />}
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
