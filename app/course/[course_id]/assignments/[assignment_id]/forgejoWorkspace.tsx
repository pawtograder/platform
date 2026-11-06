"use client";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { Badge, Box, HStack, Link, Text, VStack } from "@chakra-ui/react";
import { LuCodeXml, LuGitBranch } from "react-icons/lu";

// DEMO ONLY (Cloud Workspaces, Checkpoint 1). The real repo comes from CW-13 and the
// button from CW-17; until then this shows what a student on a Forgejo assignment sees.
const FORGEJO_URL = process.env.NEXT_PUBLIC_FORGEJO_URL || "https://forgejo.pawtograder.example";

export default function ForgejoWorkspace({
  classSlug,
  assignmentSlug
}: {
  classSlug: string | null | undefined;
  assignmentSlug: string | null | undefined;
}) {
  const repository = `${classSlug || "course"}/${assignmentSlug || "assignment"}-you`;
  return (
    <Box m={4} borderWidth={1} borderColor="bg.emphasized" borderRadius={4} p={4} bg="bg.subtle" maxW="4xl">
      <VStack alignItems="flex-start" gap={3}>
        <HStack>
          <Text fontWeight="bold">Your workspace</Text>
          <Badge colorPalette="orange">Forgejo + Coder</Badge>
        </HStack>
        <HStack>
          <LuGitBranch />
          <Text>Repository:</Text>
          <Link href={`${FORGEJO_URL}/${repository}`} target="_blank">
            {repository} (ready ✅)
          </Link>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          No GitHub account needed. Your workspace opens in the browser with this repository already cloned. Push a
          commit with <code>#submit</code> in the message to get it graded.
        </Text>
        <Button
          colorPalette="green"
          onClick={() =>
            toaster.create({
              title: "Opening Coder workspace…",
              description: "Demo: this will start your workspace with the repo cloned (CW-17).",
              type: "info"
            })
          }
        >
          <LuCodeXml /> Open in Coder
        </Button>
      </VStack>
    </Box>
  );
}
