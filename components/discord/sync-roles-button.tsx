"use client";

import { Button, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { BsDiscord, BsArrowRepeat, BsCheckCircle, BsExclamationCircle } from "react-icons/bs";
import { createClient } from "@/utils/supabase/client";
import { useState } from "react";
import { useIdentity } from "@/hooks/useIdentities";
import { Tooltip } from "../ui/tooltip";

type SyncState = "idle" | "syncing" | "success" | "error";

type SyncResult = {
  synced_classes: number;
  error?: string;
};

type SyncRolesButtonProps = {
  classId?: number; // If provided, only sync for this class
  variant?: "solid" | "outline" | "ghost" | "subtle";
  size?: "xs" | "sm" | "md" | "lg";
  showLabel?: boolean;
};

/**
 * Button component to manually trigger Discord role synchronization
 *
 * This calls the trigger_discord_role_sync_for_user RPC which enqueues
 * role sync operations for all classes the user is enrolled in.
 */
export default function SyncRolesButton({
  classId,
  variant = "outline",
  size = "sm",
  showLabel = true
}: SyncRolesButtonProps) {
  const { identities } = useIdentity();
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [result, setResult] = useState<SyncResult | null>(null);

  const discordIdentity = identities?.find((identity) => identity.provider === "discord");

  // Don't show if Discord is not linked
  if (!discordIdentity) {
    return null;
  }

  const handleSync = async () => {
    setSyncState("syncing");
    setResult(null);

    const supabase = createClient();

    try {
      const { data, error } = await supabase.rpc("trigger_discord_role_sync_for_user", {
        p_class_id: classId || null
      });

      if (error) {
        console.error("Error syncing Discord roles:", error);
        setSyncState("error");
        setResult({ synced_classes: 0, error: error.message });
        return;
      }

      const syncResult = data as SyncResult;

      if (syncResult.error) {
        setSyncState("error");
        setResult(syncResult);
      } else {
        setSyncState("success");
        setResult(syncResult);

        // Reset to idle after 3 seconds
        setTimeout(() => {
          setSyncState("idle");
        }, 3000);
      }
    } catch (err) {
      console.error("Exception syncing Discord roles:", err);
      setSyncState("error");
      setResult({
        synced_classes: 0,
        error: err instanceof Error ? err.message : "Unknown error"
      });
    }
  };

  const getButtonContent = () => {
    switch (syncState) {
      case "syncing":
        return (
          <HStack gap={2}>
            <Icon as={BsArrowRepeat} className="animate-spin" />
            {showLabel && <Text>Syncing...</Text>}
          </HStack>
        );
      case "success":
        return (
          <HStack gap={2}>
            <Icon as={BsCheckCircle} color="green.500" />
            {showLabel && <Text>Synced {result?.synced_classes || 0} class(es)</Text>}
          </HStack>
        );
      case "error":
        return (
          <HStack gap={2}>
            <Icon as={BsExclamationCircle} color="red.500" />
            {showLabel && <Text>Sync failed</Text>}
          </HStack>
        );
      default:
        return (
          <HStack gap={2}>
            <Icon as={BsDiscord} />
            {showLabel && <Text>Sync Discord Roles</Text>}
          </HStack>
        );
    }
  };

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={handleSync}
      disabled={syncState === "syncing"}
      colorPalette={syncState === "error" ? "red" : syncState === "success" ? "green" : "blue"}
    >
      {getButtonContent()}
    </Button>
  );

  // Show tooltip with error message if there was an error
  if (syncState === "error" && result?.error) {
    return <Tooltip content={result.error}>{button}</Tooltip>;
  }

  return button;
}

/**
 * A more detailed sync panel with explanation text
 */
export function SyncRolesPanel({ classId }: { classId?: number }) {
  const { identities } = useIdentity();
  const discordIdentity = identities?.find((identity) => identity.provider === "discord");

  // Don't show if Discord is not linked
  if (!discordIdentity) {
    return null;
  }

  return (
    <VStack align="stretch" gap={2} p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle">
      <HStack justify="space-between">
        <VStack align="start" gap={0}>
          <Text fontWeight="semibold" fontSize="sm">
            Sync Discord Roles
          </Text>
          <Text fontSize="xs" color="fg.muted">
            Click to sync your Pawtograder roles to Discord
          </Text>
        </VStack>
        <SyncRolesButton classId={classId} variant="solid" />
      </HStack>
      <Text fontSize="xs" color="fg.muted">
        Use this if you joined the Discord server but don&apos;t have your roles yet. You can also use the{" "}
        <code>/sync-roles</code> command in Discord.
      </Text>
    </VStack>
  );
}
