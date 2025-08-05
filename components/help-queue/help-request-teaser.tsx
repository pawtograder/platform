import { useUserProfile } from "@/hooks/useUserProfiles";
import { Avatar, Box, HStack, Stack, Text, Badge, Icon, AvatarGroup } from "@chakra-ui/react";
import { BsChatText, BsCameraVideo, BsGeoAlt, BsPeople, BsPersonVideo2 } from "react-icons/bs";
import Markdown from "react-markdown";
import type { HelpQueue } from "@/utils/supabase/DatabaseTypes";
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

  // Helper functions that use the profiles we've already loaded
  const renderStudentsDisplay = () => {
    if (students.length === 0) {
      return <Text fontWeight="medium">Unknown Student</Text>;
    }

    if (students.length === 1) {
      return <Text fontWeight="medium">{student1Profile?.name || "Unknown Student"}</Text>;
    }

    if (students.length === 2) {
      return (
        <Text fontWeight="medium">
          {student1Profile?.name || "Unknown"} & {student2Profile?.name || "Unknown"}
        </Text>
      );
    }

    return (
      <HStack spaceX={1}>
        <Text fontWeight="medium">
          {student1Profile?.name || "Unknown"} + {students.length - 1} others
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
          <Avatar.Image src={student1Profile?.avatar_url} />
          <Avatar.Fallback>{student1Profile?.name?.charAt(0) || "?"}</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    const profiles = [student1Profile, student2Profile, student3Profile].filter(Boolean);
    const maxAvatars = Math.min(3, students.length);

    return (
      <AvatarGroup size="sm">
        {profiles.slice(0, maxAvatars).map((profile, index) => (
          <Avatar.Root key={students[index]} size="sm">
            <Avatar.Image src={profile?.avatar_url} />
            <Avatar.Fallback>{profile?.name?.charAt(0) || "?"}</Avatar.Fallback>
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
