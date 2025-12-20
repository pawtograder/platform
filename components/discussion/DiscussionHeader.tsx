"use client";

import { Button } from "@/components/ui/button";
import { DiscussionSearch } from "@/components/discussion/DiscussionSearch";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import NextLink from "next/link";
import { FaPlus } from "react-icons/fa";
import { FiChevronRight } from "react-icons/fi";

export type DiscussionViewMode = "feed" | "browse";

function NavLink({ href, selected, children }: { href: string; selected: boolean; children: React.ReactNode }) {
  return (
    <NextLink href={href}>
      <Box
        px={3}
        py={1.5}
        rounded="md"
        fontSize="sm"
        fontWeight={selected ? "semibold" : "medium"}
        bg={selected ? "bg.emphasized" : "transparent"}
        color={selected ? "fg" : "fg.muted"}
        borderWidth="1px"
        borderColor={selected ? "border.emphasized" : "transparent"}
        cursor="pointer"
        transition="all 0.2s"
        _hover={{
          bg: selected ? "bg.emphasized" : "bg.subtle",
          color: "fg",
          borderColor: selected ? "border.emphasized" : "border.muted"
        }}
      >
        {children}
      </Box>
    </NextLink>
  );
}

export function DiscussionHeader({
  mode,
  onSearchChangeAction,
  newPostHref,
  discussionBaseHref,
  currentThread
}: {
  mode: DiscussionViewMode;
  onSearchChangeAction: (value: string) => void;
  newPostHref: string;
  discussionBaseHref: string;
  currentThread?: { number: number; title: string; topic?: { id: number; name: string } };
}) {
  const showPostCrumb = !!currentThread;
  return (
    <Box
      position="sticky"
      top="0"
      zIndex={10}
      bg="bg.panel"
      borderBottomWidth="1px"
      borderColor="border.emphasized"
      px={{ base: 3, md: 6 }}
      py={{ base: 3, md: 4 }}
    >
      <Flex align="center" justify="space-between" gap={4} wrap="wrap">
        <HStack gap={4} flexShrink={0} align="center">
          <HStack gap={4}>
            <NavLink href={discussionBaseHref} selected={!showPostCrumb && mode === "feed"}>
              My Feed
            </NavLink>
            <NavLink href={`${discussionBaseHref}?view=browse`} selected={!showPostCrumb && mode === "browse"}>
              Browse Topics
            </NavLink>
          </HStack>
          {currentThread && (
            <HStack gap={2} color="fg.muted">
              <FiChevronRight />
              {currentThread.topic && (
                <>
                  <NextLink href={`${discussionBaseHref}?view=browse&topic=${currentThread.topic.id}`}>
                    <Text fontSize="sm" fontWeight="medium" color="fg" _hover={{ textDecoration: "underline" }}>
                      {currentThread.topic.name}
                    </Text>
                  </NextLink>
                  <FiChevronRight />
                </>
              )}
              <Box borderBottom="3px solid" borderColor="orange.600" pb={1}>
                <Text fontSize="sm" fontWeight="semibold" color="fg" truncate maxW={{ base: "60vw", md: "40vw" }}>
                  #{currentThread.number}: {currentThread.title}
                </Text>
              </Box>
            </HStack>
          )}
        </HStack>

        <HStack gap={3} flex="1" justify="flex-end" minW={{ base: "100%", md: "auto" }}>
          <DiscussionSearch onChangeAction={onSearchChangeAction} />
          <Button asChild colorPalette="green" size="sm" flexShrink={0}>
            <NextLink href={newPostHref}>
              <FaPlus />
              New Post
            </NextLink>
          </Button>
        </HStack>
      </Flex>
    </Box>
  );
}
