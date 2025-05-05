import { useNotifications } from "@/hooks/useNotifications";
import { Box, IconButton, Badge, Popover, VStack, Portal } from "@chakra-ui/react";
import { HiOutlineInbox } from "react-icons/hi2";
import NotificationTeaser from "./notification-teaser";

export default function NotificationsBox() {
  const { notifications, set_read, dismiss } = useNotifications();
  const unreadCount = notifications?.filter((n) => !n.viewed_at).length || 0;
  return (
    <Box>
      <Popover.Root>
        <Popover.Trigger asChild>
          <IconButton variant="outline" colorPalette="gray" size="sm">
            {unreadCount > 0 && (
              <Box position="absolute" top="0" right="0" transform="translate(50%,-50%)">
                <Badge variant="solid" colorPalette="blue" size="xs">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Badge>
              </Box>
            )}
            <HiOutlineInbox width={5} height={5} />
          </IconButton>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content>
              <Popover.Arrow />
              <Popover.Body overflowY="auto">
                <Popover.Title fontWeight="medium">Notifications</Popover.Title>
                <VStack align="stretch" spaceY={0}>
                  {notifications?.map((n) => (
                    <NotificationTeaser
                      key={n.id}
                      notification_id={n.id}
                      markAsRead={() => set_read(n, true)}
                      dismiss={() => dismiss(n)}
                    />
                  ))}
                </VStack>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </Box>
  );
}
