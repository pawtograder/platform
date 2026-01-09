import { useUserProfile } from "@/hooks/useUserProfiles";
import { getQueueTypeColor } from "@/lib/utils";
import { HelpQueue } from "@/utils/supabase/DatabaseTypes";
import { Avatar, AvatarGroup, Badge, Box, HStack, Icon, Stack, Text } from "@chakra-ui/react";
import { formatRelative } from "date-fns";
import { BsCameraVideo, BsChatText, BsGeoAlt, BsPeople, BsPersonVideo2 } from "react-icons/bs";
import Markdown from "@/components/ui/markdown";
import excerpt from "@stefanprobst/remark-excerpt";
interface MessageData {
  user: string;
  updatedAt: string;
  message: string;
  isResolved: boolean;
  isAssigned: boolean;
  students?: string[];
  queue?: HelpQueue;
  isVideoLive?: boolean;
  created_by?: string;
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
  const { updatedAt, message, students = [], queue, isVideoLive = false, created_by } = props.data;
  const { selected } = props;

  // Get user profiles for up to 3 students (unconditionally)
  const student1Profile = useUserProfile(students[0] || "");
  const student2Profile = useUserProfile(students[1] || "");
  const student3Profile = useUserProfile(students[2] || "");

  // Get creator profile when there are no students
  const creatorProfile = useUserProfile(created_by || "");

  const renderStudentsDisplay = () => {
    if (students.length === 0) {
      return <Text fontWeight="medium">{creatorProfile?.name || "Unknown Student"}</Text>;
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
          <Avatar.Image src={(creatorProfile?.avatar_url || undefined) as string | undefined} />
          <Avatar.Fallback>{(creatorProfile?.name || "?").charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    if (students.length === 1) {
      return (
        <Avatar.Root size="sm">
          <Avatar.Image src={(student1Profile?.avatar_url || undefined) as string | undefined} />
          <Avatar.Fallback>{(student1Profile?.name || "?").charAt(0)}</Avatar.Fallback>
        </Avatar.Root>
      );
    }

    const maxAvatars = Math.min(3, students.length);
    const avatars = [
      {
        id: students[0],
        name: student1Profile?.name,
        avatar_url: student1Profile?.avatar_url as string | undefined
      },
      {
        id: students[1],
        name: student2Profile?.name,
        avatar_url: student2Profile?.avatar_url as string | undefined
      },
      {
        id: students[2],
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
            {message}
          </Markdown>
        </Box>
      </Stack>
    </HStack>
  );
};
