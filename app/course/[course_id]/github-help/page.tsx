"use client";

import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { syncGitHubAccount } from "@/lib/edgeFunctions";
import { useTableControllerTableValues } from "@/lib/TableController";
import { Box, Button, Heading, Link, List, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { useCallback, useMemo, useState } from "react";

export default function GitHubHelpPage() {
  const courseController = useCourseController();
  const { role: enrollment } = useClassProfiles();
  const repositories = useTableControllerTableValues(courseController.repositories);
  const githubUsername = enrollment.users.github_username;
  const githubUserId = enrollment.users.github_user_id;
  const [syncing, setSyncing] = useState(false);
  const canSync = useMemo(() => {
    return (
      enrollment.users.last_github_user_sync &&
      new Date(enrollment.users.last_github_user_sync) < new Date(new Date().getTime() - 1000 * 60 * 60 * 24)
    );
  }, [enrollment.users.last_github_user_sync]);
  const doSync = useCallback(async () => {
    setSyncing(true);
    try {
      const { message } = await syncGitHubAccount(courseController.client);
      toaster.success({
        title: "GitHub account synced",
        description: message,
        closable: true,
        duration: 30000
      });
    } catch (error) {
      Sentry.captureException(error);
      toaster.error({
        title: "Error syncing GitHub account",
        description: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
    setSyncing(false);
  }, [courseController.client]);
  return (
    <VStack p={4} alignItems="flex-start" gap={4}>
      <Heading>GitHub Access Troubleshooting</Heading>
      <Box>
        Your Pawtograder account is currently linked to the GitHub account {githubUsername} (ID: {githubUserId}). You
        can use this page to confirm that you can access repositories for this class, and to re-sync your GitHub account
        if you are having issues, or if you have changed your username on GitHub.
      </Box>
      <Box>
        <Text>
          You should be able to access the following repositories on GitHub.com if you are signed in with the account{" "}
          {githubUsername}:
        </Text>
        <List.Root as="ul" px={4}>
          {repositories.map((repository) => (
            <List.Item key={repository.id}>
              <Link href={`https://github.com/${repository.repository}`} target="_blank">
                {repository.repository}
              </Link>
            </List.Item>
          ))}
        </List.Root>
      </Box>
      <Box>
        If you are able to access these pages in your browser, but are not able to access them on your computer, please
        work with your course staff to troubleshoot the issue: this process confirms that there is nothing wrong between
        Pawtograder and GitHub.
      </Box>
      <Box>
        <Text>
          If you are certain that you are signed in with the account {githubUsername} and you still cannot access the
          repositories, you can (no more than once a day) manually trigger a sync of your GitHub account. This will also
          update your username, in the event that you have used GitHub&apos;s change username feature.
        </Text>
        <Button colorPalette="green" onClick={doSync} loading={syncing} disabled={!canSync}>
          Sync GitHub Account
        </Button>
      </Box>
    </VStack>
  );
}
