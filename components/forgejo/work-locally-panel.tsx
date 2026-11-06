"use client";

import { useCourse } from "@/hooks/useCourseController";
import { gitSetupCreateCode } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Repository } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Clipboard, Code, Heading, HStack, IconButton, Link, Tabs, Text, VStack } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { toaster } from "@/components/ui/toaster";
import { LuCodeXml } from "react-icons/lu";

const FUNCTIONS_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/git-setup`;
const CODER_URL = process.env.NEXT_PUBLIC_CODER_URL;
// Must match a Coder template that takes a `setup_url` parameter and runs it at startup.
const CODER_TEMPLATE = "kubernetes";

function CommandLine({ command }: { command: string }) {
  return (
    <HStack align="stretch" gap={2} width="100%">
      <Code flex="1" p={2} fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-all">
        {command}
      </Code>
      <Clipboard.Root value={command}>
        <Clipboard.Trigger asChild>
          <IconButton variant="outline" size="sm" aria-label="Copy command">
            <Clipboard.Indicator />
          </IconButton>
        </Clipboard.Trigger>
      </Clipboard.Root>
    </HStack>
  );
}

function useSecondsLeft(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

export default function WorkLocallyPanel({ repositories }: { repositories: Repository[] }) {
  const course = useCourse();
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingCoder, setOpeningCoder] = useState(false);
  const secondsLeft = useSecondsLeft(code?.expires_at ?? null);

  const forgejoRepos = repositories.filter((r) => r.git_provider === "forgejo" && r.is_github_ready);
  if (forgejoRepos.length === 0) {
    return null;
  }
  const forgejoUrl = process.env.NEXT_PUBLIC_FORGEJO_URL;

  const getCommand = async () => {
    setLoading(true);
    try {
      setCode(await gitSetupCreateCode({ class_id: course.id }, createClient()));
    } catch (e) {
      toaster.error({ title: "Could not create a setup command", description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };
  const expired = code !== null && secondsLeft === 0;

  // The workspace runs the same one-time setup URL as a laptop, so it gets its own code.
  const openInCoder = async () => {
    // Open the tab before awaiting, or the browser blocks it as a popup.
    const tab = window.open("", "_blank");
    setOpeningCoder(true);
    try {
      const { code: workspaceCode } = await gitSetupCreateCode({ class_id: course.id }, createClient());
      const params = new URLSearchParams({ mode: "auto", "param.setup_url": `${FUNCTIONS_URL}/${workspaceCode}` });
      const url = `${CODER_URL}/templates/${CODER_TEMPLATE}/workspace?${params}`;
      if (tab) {
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (e) {
      tab?.close();
      toaster.error({ title: "Could not open a workspace", description: (e as Error).message });
    } finally {
      setOpeningCoder(false);
    }
  };

  return (
    <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <VStack align="stretch" gap={3}>
        <Heading size="md">Your repository</Heading>
        <Text fontSize="sm">
          Your repository is on the course&apos;s own git server. You don&apos;t need a GitHub account or anything else
          to install besides git.{" "}
          <Link href={`${forgejoUrl}/${forgejoRepos[0].repository}`} target="_blank" colorPalette="blue">
            View it on the course git server
          </Link>
          .
        </Text>
        {CODER_URL && (
          <HStack>
            <Button size="sm" colorPalette="blue" loading={openingCoder} onClick={openInCoder}>
              <LuCodeXml />
              Open in Coder
            </Button>
            <Text fontSize="sm" color="fg.muted">
              A workspace in your browser with this repository already cloned.
            </Text>
          </HStack>
        )}
        {!code || expired ? (
          <HStack>
            <Button size="sm" colorPalette="green" loading={loading} onClick={getCommand}>
              {expired ? "Get a new setup command" : "Set up git on this computer"}
            </Button>
            {expired && (
              <Text fontSize="sm" color="fg.muted">
                That command expired. Commands work once, for ten minutes.
              </Text>
            )}
          </HStack>
        ) : (
          <VStack align="stretch" gap={2}>
            <Text fontSize="sm">
              Open a terminal in the folder where you keep your coursework, then paste this command. It saves your git
              login for the course server and downloads your repository. It works once, for the next{" "}
              <b>
                {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </b>
              .
            </Text>
            <Tabs.Root defaultValue="unix" variant="line" size="sm">
              <Tabs.List>
                <Tabs.Trigger value="unix">macOS / Linux</Tabs.Trigger>
                <Tabs.Trigger value="windows">Windows (PowerShell)</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="unix">
                <CommandLine command={`curl -fsSL ${FUNCTIONS_URL}/${code.code} | sh`} />
              </Tabs.Content>
              <Tabs.Content value="windows">
                <CommandLine command={`irm "${FUNCTIONS_URL}/${code.code}?shell=ps1" | iex`} />
              </Tabs.Content>
            </Tabs.Root>
            <Text fontSize="xs" color="fg.muted">
              Want to read it first?{" "}
              <Link href={`${FUNCTIONS_URL}/preview`} target="_blank">
                See the script
              </Link>{" "}
              (with your token left out). Setting up again, on this or another computer, replaces the previous login.
            </Text>
          </VStack>
        )}
        <Text fontSize="xs" color="fg.muted">
          Already set up? Clone URL: <Code fontSize="xs">{`${forgejoUrl}/${forgejoRepos[0].repository}.git`}</Code>
        </Text>
      </VStack>
    </Box>
  );
}
