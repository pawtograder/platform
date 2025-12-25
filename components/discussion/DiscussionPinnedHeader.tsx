"use client";

import { Icon, HStack, Heading } from "@chakra-ui/react";
import { FaThumbtack } from "react-icons/fa";

export function DiscussionPinnedHeader() {
  return (
    <HStack gap={2}>
      <Icon as={FaThumbtack} color="fg.info" />
      <Heading size="sm">Pinned Posts</Heading>
    </HStack>
  );
}
