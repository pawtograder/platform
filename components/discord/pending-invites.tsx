"use client";

import { Box, Button, Heading, HStack, Icon, Link, Stack, Text, VStack } from "@chakra-ui/react";
import { BsDiscord, BsExclamationCircle } from "react-icons/bs";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";
import { Alert } from "../ui/alert";
import { Tooltip } from "../ui/tooltip";
import useAuthState from "@/hooks/useAuthState";
import SyncRolesButton from "./sync-roles-button";

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
          .select("*, classes(id, slug, name)")
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
        setInvites((data || []) as DiscordInvite[]);
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

  if (loading) {
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
                    <Link
                      href={invite.invite_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      _hover={{ textDecoration: "none" }}
                    >
                      <Button colorPalette="blue" size="sm">
                        <HStack gap={2}>
                          <Icon as={BsDiscord} />
                          <Text>Join Discord Server</Text>
                        </HStack>
                      </Button>
                    </Link>
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
            <Text fontSize="xs" color="fg.muted">
              Your roles will be synced automatically within an hour. For immediate sync, use the button below or type{" "}
              <code>/sync-roles</code> in the Discord server.
            </Text>
            {!showAll && (
              <HStack>
                <SyncRolesButton classId={classId} variant="outline" size="sm" />
              </HStack>
            )}
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
