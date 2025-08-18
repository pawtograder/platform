import { useUserProfile } from "@/hooks/useUserProfiles";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Avatar, Box, HStack, Stack, Text, Badge, Icon, AvatarGroup } from "@chakra-ui/react";
import { BsChatText, BsCameraVideo, BsGeoAlt, BsPeople, BsPersonVideo2 } from "react-icons/bs";
import Markdown from "react-markdown";
import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { getQueueTypeColor } from "@/lib/utils";
import { formatRelative } from "date-fns";

interface MessageData {
  user: string;
  updatedAt: string;
  message: string;
  isResolved: boolean;
  isAssigned: boolean;
  students?: string[];
  queue?: HelpQueue;
  isVideoLive?: boolean;
}

interface Props {
  data: MessageData;
  selected?: boolean;
}

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

export const HelpRequestTeaser = (props: Props) => {
  const { updatedAt, message, students = [], queue, isVideoLive = false } = props.data;
  const { selected } = props;

  // Get user profiles for up to 3 students (unconditionally)
  const student1Profile = useUserProfile(students[0] || "");
  const student2Profile = useUserProfile(students[1] || "");
  const student3Profile = useUserProfile(students[2] || "");

  // Fallback to class roster when individual profile hook hasn't populated yet
  const { profiles: rosterProfiles } = useClassProfiles();
  const rosterProfile1 = rosterProfiles.find((p) => p.id === (students[0] || ""));
  const rosterProfile2 = rosterProfiles.find((p) => p.id === (students[1] || ""));
  const rosterProfile3 = rosterProfiles.find((p) => p.id === (students[2] || ""));

  const getBestName = (p: unknown): string => {
    const u = p as { name?: string; short_name?: string; sortable_name?: string } | undefined;
    return u?.name || u?.short_name || u?.sortable_name || "";
  };

  // Helper functions that use the profiles we've already loaded
  const renderStudentsDisplay = () => {
    if (students.length === 0) {
      return <Text fontWeight="medium">Unknown Student</Text>;
    }

    if (students.length === 1) {
      return (
        <Text fontWeight="medium">{student1Profile?.name || getBestName(rosterProfile1) || "Unknown Student"}</Text>
      );
    }

    if (students.length === 2) {
      return (
        <Text fontWeight="medium">
          {student1Profile?.name || getBestName(rosterProfile1) || "Unknown"} &{" "}
          {student2Profile?.name || getBestName(rosterProfile2) || "Unknown"}
        </Text>
      );
    }

    return (
      <HStack spaceX={1}>
        <Text fontWeight="medium">
          {student1Profile?.name || getBestName(rosterProfile1) || "Unknown"} + {students.length - 1} others
        </Text>
        <Icon as={BsPeople} fontSize="sm" color="fg.muted" />
      </HStack>
    );
  };

  const renderStudentsAvatars = () => {
    if (students.length === 0) {
      return (
        <Avatar.Root size="sm">
          <Avatar.Fallback>?</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    if (students.length === 1) {
      return (
        <Avatar.Root size="sm">
          <Avatar.Image
            src={(student1Profile?.avatar_url || rosterProfile1?.avatar_url || undefined) as string | undefined}
          />
          <Avatar.Fallback>{(student1Profile?.name || getBestName(rosterProfile1) || "?").charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    const maxAvatars = Math.min(3, students.length);
    const avatars = [
      {
        id: students[0],
        name: student1Profile?.name || getBestName(rosterProfile1),
        avatar_url: (student1Profile?.avatar_url || rosterProfile1?.avatar_url) as string | undefined
      },
      {
        id: students[1],
        name: student2Profile?.name || getBestName(rosterProfile2),
        avatar_url: (student2Profile?.avatar_url || rosterProfile2?.avatar_url) as string | undefined
      },
      {
        id: students[2],
        name: student3Profile?.name || getBestName(rosterProfile3),
        avatar_url: (student3Profile?.avatar_url || rosterProfile3?.avatar_url) as string | undefined
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

  const stripTrailingQueueName = (name: string) => {
    if (name.endsWith(" Queue")) {
      return name.slice(0, -5);
    }
    return name;
  };

  return (
    <HStack
      align="flex-start"
      gap="3"
      px="4"
      py="3"
      _hover={{ bg: "bg.muted" }}
      rounded="md"
      bg={selected ? "bg.muted" : ""}
      role="listitem"
      aria-label={`${message}`}
    >
      <Box pt="1">{renderStudentsAvatars()}</Box>
      <Stack spaceY="0" fontSize="sm" flex="1" truncate>
        <HStack spaceX="1" justify="space-between">
          {queue && (
            <Badge colorPalette={getQueueTypeColor(queue.queue_type)} variant="surface" size="xs">
              <Icon as={getQueueIcon(queue.queue_type)} fontSize="xs" />
              {stripTrailingQueueName(queue.name)}
            </Badge>
          )}
          <Text fontSize="xs">{formatRelative(new Date(updatedAt), new Date())}</Text>
        </HStack>
        <HStack spaceX="1" justify="space-between">
          <Box flex="1" truncate>
            {renderStudentsDisplay()}
          </Box>
          <HStack spaceX="2">
            {isVideoLive && (
              <Badge colorPalette="green" variant="solid" size="xs">
                <Icon as={BsPersonVideo2} fontSize="xs" />
                Live
              </Badge>
            )}
          </HStack>
        </HStack>
        <Box truncate>
          <Markdown>{message}</Markdown>
        </Box>
      </Stack>
    </HStack>
  );
};
