"use client";

import { Avatar, AvatarGroup, Badge, Box, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import Link from "next/link";
import { useMemo } from "react";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { HelpRequest, HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { getQueueTypeColor } from "@/lib/utils";
import { BsCameraVideo, BsChatText, BsGeoAlt, BsPersonCheck, BsPersonDash } from "react-icons/bs";
import Markdown from "@/components/ui/markdown";
import excerpt from "@stefanprobst/remark-excerpt";

/**
 * Get icon for queue type
 */
const getQueueIcon = (type: string) => {
  switch (type) {
    case "video":
      return BsCameraVideo;
    case "in_person":
      return BsGeoAlt;
    default:
      return BsChatText;
  }
};

interface RequestRowProps {
  request: HelpRequest;
  href: string;
  selected?: boolean;
  queue?: HelpQueue;
  students?: string[];
  variant?: "default" | "compact";
}

export function RequestRow({ request, href, selected, queue, students = [], variant = "default" }: RequestRowProps) {
  // Use created_by as fallback when students array is empty
  const effectiveStudents = students.length > 0 ? students : request.created_by ? [request.created_by] : [];
  const student1Profile = useUserProfile(effectiveStudents[0] || null);
  const student2Profile = useUserProfile(effectiveStudents[1] || null);
  const student3Profile = useUserProfile(effectiveStudents[2] || null);
  const assigneeProfile = useUserProfile(request.assignee || null);

  const statusColor = useMemo(() => {
    switch (request.status) {
      case "resolved":
        return "green";
      case "in_progress":
        return "orange";
      case "closed":
        return "gray";
      default:
        return "blue";
    }
  }, [request.status]);

  const renderStudentsDisplay = () => {
    if (effectiveStudents.length === 0) {
      return (
        <Text fontWeight="medium" fontSize="sm">
          Unknown Student
        </Text>
      );
    }

    if (effectiveStudents.length === 1) {
      return (
        <Text fontWeight="medium" fontSize="sm">
          {student1Profile?.name || "Unknown Student"}
        </Text>
      );
    }

    if (effectiveStudents.length === 2) {
      return (
        <Text fontWeight="medium" fontSize="sm">
          {student1Profile?.name || "Unknown"} & {student2Profile?.name || "Unknown"}
        </Text>
      );
    }

    return (
      <Text fontWeight="medium" fontSize="sm">
        {student1Profile?.name || "Unknown"} + {effectiveStudents.length - 1} others
      </Text>
    );
  };

  const renderStudentsAvatars = () => {
    if (effectiveStudents.length === 0) {
      return (
        <Avatar.Root size="sm">
          <Avatar.Fallback>?</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    if (effectiveStudents.length === 1) {
      return (
        <Avatar.Root size="sm">
          <Avatar.Image src={(student1Profile?.avatar_url || undefined) as string | undefined} />
          <Avatar.Fallback>{(student1Profile?.name || "?").charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    const maxAvatars = Math.min(3, effectiveStudents.length);
    const avatars = [
      {
        id: effectiveStudents[0],
        name: student1Profile?.name,
        avatar_url: student1Profile?.avatar_url as string | undefined
      },
      {
        id: effectiveStudents[1],
        name: student2Profile?.name,
        avatar_url: student2Profile?.avatar_url as string | undefined
      },
      {
        id: effectiveStudents[2],
        name: student3Profile?.name,
        avatar_url: student3Profile?.avatar_url as string | undefined
      }
    ].slice(0, maxAvatars);

    return (
      <AvatarGroup size="sm">
        {avatars.map((p) => (
          <Avatar.Root key={p.id} size="sm">
            <Avatar.Image src={p.avatar_url} />
            <Avatar.Fallback>{(p.name || "?").charAt(0)}</Avatar.Fallback>
          </Avatar.Root>
        ))}
      </AvatarGroup>
    );
  };

  if (variant === "compact") {
    return (
      <Box asChild>
        <Link href={href} aria-label={request.request}>
          <Box
            px="4"
            py="2"
            borderBottomWidth="1px"
            borderColor="border.muted"
            bg={selected ? "bg.muted" : request.status === "open" ? "bg.info" : "bg"}
            _hover={{ bg: "bg.subtle" }}
          >
            <Stack spaceY="1">
              <HStack gap="2" align="flex-start">
                <Box pt="0.5">{renderStudentsAvatars()}</Box>
                <Stack spaceY="0.5" flex="1" minW={0}>
                  <HStack gap="1.5" minW={0} wrap="wrap">
                    {queue && (
                      <Badge colorPalette={getQueueTypeColor(queue.queue_type)} variant="surface" size="xs">
                        <Icon as={getQueueIcon(queue.queue_type)} fontSize="xs" />
                        {queue.name}
                      </Badge>
                    )}
                    <Badge colorPalette={statusColor} variant="subtle" size="xs">
                      {request.status}
                    </Badge>
                    {request.assignee && (
                      <Badge
                        colorPalette={request.assignee === request.created_by ? "green" : "blue"}
                        variant="subtle"
                        size="xs"
                      >
                        <Icon as={BsPersonCheck} fontSize="xs" />
                        {assigneeProfile?.name || "Assigned"}
                      </Badge>
                    )}
                  </HStack>
                  <HStack gap="2" fontSize="xs" color="fg.muted" wrap="wrap">
                    {renderStudentsDisplay()}
                    <Text>•</Text>
                    <Text>{formatRelative(new Date(request.created_at), new Date())}</Text>
                  </HStack>
                </Stack>
              </HStack>
            </Stack>
          </Box>
        </Link>
      </Box>
    );
  }

  return (
    <Box asChild>
      <Link href={href} aria-label={request.request}>
        <HStack
          gap="3"
          px="4"
          py="3"
          borderBottomWidth="1px"
          borderColor="border.muted"
          align="flex-start"
          bg={selected ? "bg.muted" : request.status === "open" ? "bg.info" : "bg"}
          _hover={{ bg: "bg.subtle" }}
        >
          <Box pt="1">{renderStudentsAvatars()}</Box>

          <Stack spaceY="1" flex="1" minW={0}>
            <HStack gap="2" minW={0} wrap="wrap">
              {queue && (
                <Badge colorPalette={getQueueTypeColor(queue.queue_type)} variant="subtle" flexShrink={0}>
                  {queue.name}
                </Badge>
              )}
              <Badge colorPalette={statusColor} variant="subtle">
                {request.status}
              </Badge>
              {request.assignee ? (
                <Badge colorPalette="green" variant="subtle">
                  <Icon as={BsPersonCheck} mr={1} />
                  {assigneeProfile?.name || "Assigned"}
                </Badge>
              ) : (
                <Badge colorPalette="gray" variant="outline">
                  <Icon as={BsPersonDash} mr={1} />
                  Unassigned
                </Badge>
              )}
            </HStack>

            <HStack gap="3" fontSize="xs" color="fg.muted" wrap="wrap">
              {renderStudentsDisplay()}
              <Text>•</Text>
              <Text>{formatRelative(new Date(request.created_at), new Date())}</Text>
            </HStack>

            <Box truncate>
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
                {request.request}
              </Markdown>
            </Box>
          </Stack>
        </HStack>
      </Link>
    </Box>
  );
}
