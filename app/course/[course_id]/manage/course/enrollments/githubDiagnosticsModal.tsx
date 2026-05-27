"use client";

import { PopConfirm } from "@/components/ui/popconfirm";
import { Skeleton } from "@/components/ui/skeleton";
import { toaster } from "@/components/ui/toaster";
import {
  diagnoseInstructorGitHubAccount,
  syncInstructorGitHubAccount,
  unlinkInstructorGitHubAccount
} from "@/lib/edgeFunctions";
import type { GitHubLinkStatus, GitHubMembershipStatus } from "@/supabase/functions/_shared/FunctionTypes";
import { createClient } from "@/utils/supabase/client";
import { Badge, Button, Dialog, HStack, Portal, Spinner, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BsGithub } from "react-icons/bs";

type GitHubDiagnosticsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  courseId: number;
  userRoleId: number;
  studentName: string | null | undefined;
};

function membershipLabel(status: GitHubMembershipStatus) {
  if (status.state === "active") {
    return "Joined";
  }
  if (status.state === "pending") {
    return "Pending invitation";
  }
  if (status.state === "not_found") {
    return "Not joined";
  }
  return "Unknown";
}

function membershipColor(status: GitHubMembershipStatus) {
  if (status.state === "active") {
    return "green";
  }
  if (status.state === "pending") {
    return "yellow";
  }
  if (status.state === "not_found") {
    return "red";
  }
  return "gray";
}

function StatusRow({ label, value, detail }: { label: string; value: ReactNode; detail?: string | null }) {
  return (
    <HStack align="start" justify="space-between" w="100%" gap={4}>
      <Text fontWeight="medium">{label}</Text>
      <VStack align="end" gap={1}>
        {value}
        {detail && (
          <Text color="fg.muted" fontSize="sm" textAlign="right">
            {detail}
          </Text>
        )}
      </VStack>
    </HStack>
  );
}

export default function GitHubDiagnosticsModal({
  isOpen,
  onClose,
  courseId,
  userRoleId,
  studentName
}: GitHubDiagnosticsModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState<GitHubLinkStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await diagnoseInstructorGitHubAccount({ courseId, userRoleId }, supabase);
      setStatus(response.status);
    } catch (error) {
      Sentry.captureException(error);
      toaster.error({
        title: "Error diagnosing GitHub account",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsLoading(false);
    }
  }, [courseId, supabase, userRoleId]);

  useEffect(() => {
    if (isOpen) {
      void fetchStatus();
    } else {
      setStatus(null);
    }
  }, [fetchStatus, isOpen]);

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const response = await syncInstructorGitHubAccount({ courseId, userRoleId }, supabase);
      setStatus(response.status);
      toaster.success({
        title: "GitHub permissions synced",
        description: response.message || "Student GitHub permissions were synced."
      });
    } catch (error) {
      Sentry.captureException(error);
      toaster.error({
        title: "Error syncing GitHub permissions",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsSyncing(false);
    }
  }, [courseId, supabase, userRoleId]);

  const handleUnlink = useCallback(async () => {
    setIsUnlinking(true);
    try {
      const response = await unlinkInstructorGitHubAccount({ courseId, userRoleId }, supabase);
      setStatus(response.status);
      toaster.success({
        title: "GitHub identity unlinked",
        description: response.message
      });
    } catch (error) {
      Sentry.captureException(error);
      toaster.error({
        title: "Error unlinking GitHub identity",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsUnlinking(false);
    }
  }, [courseId, supabase, userRoleId]);

  const linkedUsername = status?.currentGithubUsername ?? status?.githubUsername ?? null;
  const isBusy = isLoading || isSyncing || isUnlinking;
  const isActionDisabled = isBusy || !status;
  const busyMessage = isSyncing
    ? "Resyncing GitHub status..."
    : isUnlinking
      ? "Unlinking GitHub identity..."
      : "Fetching GitHub status...";
  const skeletonBadge = <Skeleton height="6" width="24" />;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Diagnose GitHub errors</Dialog.Title>
              <Dialog.CloseTrigger onClick={onClose} />
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={4}>
                <Text color="fg.muted">
                  Checking GitHub link status for {studentName || "this student"} in this course.
                </Text>
                {isBusy && (
                  <HStack>
                    <Spinner size="sm" />
                    <Text>{busyMessage}</Text>
                  </HStack>
                )}
                <VStack align="stretch" gap={3}>
                  <StatusRow
                    label="Linked account"
                    value={
                      isBusy ? (
                        skeletonBadge
                      ) : linkedUsername ? (
                        <Badge colorPalette="blue">
                          <BsGithub /> {linkedUsername}
                        </Badge>
                      ) : (
                        <Badge colorPalette="red">No GitHub account linked</Badge>
                      )
                    }
                    detail={!isBusy && status?.githubUserId ? `GitHub ID: ${status.githubUserId}` : null}
                  />
                  <StatusRow
                    label="Username changed"
                    value={
                      isBusy ? (
                        skeletonBadge
                      ) : status?.usernameChanged ? (
                        <Badge colorPalette="yellow">Yes</Badge>
                      ) : (
                        <Badge colorPalette="green">No</Badge>
                      )
                    }
                    detail={
                      !isBusy && status?.usernameChanged
                        ? `Stored as ${status.githubUsername}, now ${status.currentGithubUsername}`
                        : null
                    }
                  />
                  <StatusRow
                    label="Organization"
                    value={
                      isBusy ? (
                        skeletonBadge
                      ) : status ? (
                        <Badge colorPalette={membershipColor(status.orgMembership)}>
                          {membershipLabel(status.orgMembership)}
                        </Badge>
                      ) : (
                        skeletonBadge
                      )
                    }
                    detail={!isBusy && status ? (status.orgMembership.error ?? status.classOrg) : null}
                  />
                  <StatusRow
                    label="Student team"
                    value={
                      isBusy ? (
                        skeletonBadge
                      ) : status ? (
                        <Badge colorPalette={membershipColor(status.teamMembership)}>
                          {membershipLabel(status.teamMembership)}
                        </Badge>
                      ) : (
                        skeletonBadge
                      )
                    }
                    detail={!isBusy && status ? (status.teamMembership.error ?? status.studentTeamSlug) : null}
                  />
                  <StatusRow
                    label="Database org status"
                    value={
                      isBusy ? (
                        skeletonBadge
                      ) : status?.githubOrgConfirmed ? (
                        <Badge colorPalette="green">Confirmed</Badge>
                      ) : (
                        <Badge colorPalette="red">Not confirmed</Badge>
                      )
                    }
                  />
                </VStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="100%" gap={3}>
                <PopConfirm
                  triggerLabel="Unlink GitHub identity"
                  trigger={
                    <Button colorPalette="red" variant="surface" loading={isUnlinking} disabled={isActionDisabled}>
                      Unlink GitHub identity
                    </Button>
                  }
                  confirmHeader="Unlink GitHub identity"
                  confirmText="This removes the student's GitHub identity from Pawtograder and removes them from the class GitHub organization."
                  onConfirm={handleUnlink}
                  placement="top-start"
                />
                <HStack>
                  <Button variant="ghost" onClick={onClose}>
                    Close
                  </Button>
                  <Button colorPalette="green" onClick={handleSync} loading={isSyncing} disabled={isActionDisabled}>
                    Sync permissions
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
