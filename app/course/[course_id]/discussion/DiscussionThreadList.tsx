"use client";

import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";

import Markdown from "@/components/ui/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import {
  Avatar,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Icon,
  Input,
  Select,
  Separator,
  Spacer,
  Stack,
  Text,
  VStack,
  Portal,
  createListCollection
} from "@chakra-ui/react";
import excerpt from "@stefanprobst/remark-excerpt";
import { formatRelative, isThisMonth, isThisWeek, isToday } from "date-fns";
import NextLink from "next/link";
import { Fragment, useId, useState, useMemo } from "react";
import { FaPlus, FaHeart } from "react-icons/fa";
import {
  useDiscussionThreadReadStatus,
  useDiscussionThreadTeaser,
  useDiscussionThreadTeasers
} from "@/hooks/useCourseController";
import { useClassProfiles } from "@/hooks/useClassProfiles";

interface Props {
  thread_id: number;
  selected?: boolean;
  width?: string;
}

export const DiscussionThreadTeaser = (props: Props) => {
  const thread = useDiscussionThreadTeaser(props.thread_id);
  const avatarTriggerId = useId();
  const { root_id } = useParams();
  const selected = root_id ? props.thread_id === Number.parseInt(root_id as string) : false;
  const is_answered = thread?.answer != undefined;

  const { readStatus } = useDiscussionThreadReadStatus(props.thread_id);

  const userProfile = useUserProfile(thread?.author);
  return (
    <Box position="relative" width={props.width || "100%"}>
      <NextLink href={`/course/${thread?.class_id}/discussion/${thread?.id}`} prefetch={true}>
        <Box position="absolute" left="1" top="50%" transform="translateY(-50%)">
          {!readStatus?.read_at && <Box w="8px" h="8px" bg="blue.500" rounded="full"></Box>}
        </Box>
        <HStack
          align="flex-start"
          gap="3"
          px="4"
          py="3"
          _hover={{ bg: "bg.muted" }}
          rounded="md"
          width="100%"
          bg={!readStatus?.read_at ? "bg.info" : selected ? "bg.muted" : ""}
        >
          <Box pt="1">
            <Tooltip ids={{ trigger: avatarTriggerId }} openDelay={0} showArrow content={userProfile?.name}>
              <Avatar.Root size="xs">
                <Avatar.Image id={avatarTriggerId} src={userProfile?.avatar_url} />
                <Avatar.Fallback id={avatarTriggerId}>{userProfile?.name?.charAt(0) || "?"}</Avatar.Fallback>
              </Avatar.Root>
            </Tooltip>
          </Box>
          <Stack spaceY="0" fontSize="sm" flex="1" truncate>
            <Text
              fontWeight="medium"
              flex="1"
              css={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}
            >
              #{thread?.ordinal} {thread?.subject}
            </Text>
            {thread?.is_question && !is_answered && (
              <Box>
                <Badge colorPalette="red">Unanswered</Badge>
              </Box>
            )}
            {is_answered && (
              <Box>
                <Badge colorPalette="green">Answered</Badge>
              </Box>
            )}
            <Box color="fg.subtle" truncate>
              <Markdown
                components={{
                  a: ({ children }) => children,
                  img: () => (
                    <Text as="span" color="gray.500">
                      [image]
                    </Text>
                  ),
                  code: ({ children }) => children,
                  pre: ({ children }) => children,
                  blockquote: ({ children }) => children,
                  h1: ({ children }) => children,
                  h2: ({ children }) => children,
                  h3: ({ children }) => children
                }}
                remarkPlugins={[[excerpt, { maxLength: 100 }]]}
              >
                {thread?.body}
              </Markdown>
              <HStack>
                <Text fontSize="xs" color="text.muted">
                  {thread?.children_count ?? 0} replies
                </Text>
                {thread?.likes_count != null && thread.likes_count > 0 && (
                  <HStack alignItems="center">
                    <Icon as={FaHeart} color="fg.subtle" boxSize="3" />
                    <Text fontSize="xs" color="text.muted">
                      {thread.likes_count}
                    </Text>
                  </HStack>
                )}
                {(readStatus?.numReadDescendants ?? 0) < (readStatus?.current_children_count ?? 0) && (
                  <Badge colorScheme="blue">
                    {Math.max(0, (readStatus?.current_children_count ?? 0) - (readStatus?.numReadDescendants ?? 0))} new
                  </Badge>
                )}
                <Spacer />
                <Text fontSize="xs" color="text.muted">
                  {thread?.created_at ? formatRelative(new Date(thread?.created_at), new Date()) : ""}
                </Text>
              </HStack>
            </Box>
          </Stack>
        </HStack>
      </NextLink>
    </Box>
  );
};

export default function DiscussionThreadList() {
  const { course_id } = useParams();
  const { public_profile_id, private_profile_id } = useClassProfiles();
  const list = useDiscussionThreadTeasers();
  const { data: topics } = useList<DiscussionTopic>({
    resource: "discussion_topics",
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const [searchTerm, setSearchTerm] = useState("");
  const [filterOption, setFilterOption] = useState("all");
  const [sortOption, setSortOption] = useState("newest");

  const processedList = useMemo(() => {
    let filteredList = list;

    if (filterOption === "unread") {
      // TODO: Implement unread filter - requires readStatus for all teasers, might need adjustment in useCourseController
      // For now, filtering by unread is complex with current hooks, skipping implementation.
    } else if (filterOption === "unanswered") {
      filteredList = list.filter((thread) => thread.is_question && !thread.answer);
    } else if (filterOption === "answered") {
      filteredList = list.filter((thread) => thread.is_question && thread.answer);
    } else if (filterOption === "my_posts") {
      filteredList = list.filter(
        (thread) => thread.author === public_profile_id || thread.author === private_profile_id
      );
    } else if (filterOption.startsWith("topic-")) {
      const topicId = parseInt(filterOption.split("-")[1]);
      filteredList = list.filter((thread) => thread.topic_id === topicId);
    }

    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      filteredList = filteredList.filter(
        (thread) =>
          thread.subject?.toLowerCase().includes(lowerSearchTerm) ||
          thread.body?.toLowerCase().includes(lowerSearchTerm)
      );
    }

    const sortedList = [...filteredList];
    if (sortOption === "newest") {
      sortedList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sortOption === "oldest") {
      sortedList.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (sortOption === "replies") {
      sortedList.sort((a, b) => (b.children_count ?? 0) - (a.children_count ?? 0));
    } else if (sortOption === "likes") {
      sortedList.sort((a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0));
    }

    return sortedList;
  }, [list, searchTerm, filterOption, sortOption, public_profile_id, private_profile_id]);

  const getThreadGroup = (date: Date) => {
    if (isToday(date)) {
      return "Today";
    } else if (isThisWeek(date)) {
      return "This Week";
    } else if (isThisMonth(date)) {
      return "This Month";
    } else {
      return "Older";
    }
  };

  // Create collections for Select components
  const filterCollection = useMemo(() => {
    const items = [
      { value: "all", label: "All Threads" },
      { value: "unanswered", label: "Unanswered Questions" },
      { value: "answered", label: "Answered Questions" },
      { value: "my_posts", label: "My Posts" },
      ...(topics?.data?.map((topic) => ({ value: `topic-${topic.id}`, label: topic.topic })) || [])
    ];
    return createListCollection({ items });
  }, [topics?.data]);

  const sortCollection = useMemo(() => {
    const items = [
      { value: "newest", label: "Newest" },
      { value: "oldest", label: "Oldest" },
      { value: "replies", label: "Most Replies" },
      { value: "likes", label: "Most Liked" }
    ];
    return createListCollection({ items });
  }, []);

  return (
    <Flex width="314px" height="100vh" bottom={0} direction="column" top={0} justify="space-between" align="center">
      <Box p="4" w="100%">
        <Heading size="md" mb="2">
          Discussion Feed
        </Heading>
        <Button asChild size="sm" variant="surface" colorScheme="green" mb="4" width="100%">
          <NextLink prefetch={true} href={`/course/${course_id}/discussion/new`}>
            <Icon as={FaPlus} mr="1" />
            New Thread
          </NextLink>
        </Button>

        <VStack mb="4" align="stretch">
          <Input
            placeholder="Search threads..."
            value={searchTerm}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
            size="sm"
          />
          <Select.Root
            collection={filterCollection}
            size="sm"
            value={filterOption ? [filterOption] : []}
            onValueChange={(details) => setFilterOption(details.value[0] || "all")}
            width="100%"
          >
            <Select.Label display="none">Filter discussion threads</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder="Filter by..." />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {filterCollection.items.map((item) => (
                    <Select.Item key={item.value} item={item}>
                      {item.label}
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
            <Select.HiddenSelect aria-label="Filter discussion threads" />
          </Select.Root>

          <Select.Root
            collection={sortCollection}
            size="sm"
            value={sortOption ? [sortOption] : []}
            onValueChange={(details) => setSortOption(details.value[0] || "newest")}
            width="100%"
          >
            <Select.Label display="none">Sort discussion threads</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder="Sort by..." />
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Portal>
              <Select.Positioner>
                <Select.Content>
                  {sortCollection.items.map((item) => (
                    <Select.Item key={item.value} item={item}>
                      {item.label}
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Portal>
            <Select.HiddenSelect aria-label="Sort discussion threads" />
          </Select.Root>
        </VStack>
      </Box>

      <Box width="100%" flex={1} overflowY="auto" pr="4">
        <Box role="list" aria-busy={list === undefined} aria-live="polite" aria-label="Discussion threads">
          {list === undefined && <Skeleton height="300px" />}
          {processedList.length === 0 && (
            <Text p="4" color="text.muted">
              No threads match your criteria.
            </Text>
          )}
          {processedList.map((thread, index) => {
            const header = getThreadGroup(new Date(thread.created_at));
            const prevThread = processedList[index - 1];
            const isFirstInGroup = !prevThread || getThreadGroup(new Date(prevThread.created_at)) !== header;

            return (
              <Fragment key={thread.id}>
                {isFirstInGroup && (
                  <HStack px="4" pt="2">
                    <Separator flex="1" />
                    <Text fontSize="sm" fontWeight="light" color="text.muted" flexShrink="0">
                      {header}
                    </Text>
                    <Separator flex="1" />
                  </HStack>
                )}
                <DiscussionThreadTeaser thread_id={thread.id} />
              </Fragment>
            );
          })}
        </Box>
      </Box>
    </Flex>
  );
}
