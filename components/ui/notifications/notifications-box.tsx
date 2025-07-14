import { Tooltip } from "@/components/ui/tooltip";
import { useNotifications } from "@/hooks/useNotifications";
import { Badge, Box, IconButton, VStack, Text } from "@chakra-ui/react";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverBody } from "@/components/ui/popover";
import { HiOutlineInbox } from "react-icons/hi2";
import NotificationTeaser from "./notification-teaser";
import { useState } from "react";

export default function NotificationsBox() {
  const { notifications, set_read, dismiss } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const unreadCount = notifications?.filter((n) => !n.viewed_at).length || 0;

  return (
    <Box>
      <PopoverRoot
        closeOnInteractOutside={true}
        open={isOpen}
        onOpenChange={(details) => setIsOpen(details.open)}
        positioning={{ placement: "bottom-end" }}
      >
        <Tooltip content="Notifications" showArrow>
          <Box display="inline-block">
            <PopoverTrigger asChild>
              <IconButton
                variant="outline"
                colorPalette="gray"
                size="sm"
                onClick={() => setIsOpen(!isOpen)}
                position="relative"
              >
                {unreadCount > 0 && (
                  <Badge
                    variant="solid"
                    colorPalette="blue"
                    size="xs"
                    position="absolute"
                    top="-1"
                    right="-1"
                    borderRadius="full"
                    minW="18px"
                    h="18px"
                    fontSize="10px"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </Badge>
                )}
                <HiOutlineInbox size={18} />
              </IconButton>
            </PopoverTrigger>
          </Box>
        </Tooltip>
        <PopoverContent shadow="lg" borderRadius="lg" borderWidth="1px" portalled={false}>
          <PopoverBody p="0">
            <Box p="4" borderBottom="1px" borderColor="border.muted">
              <Text fontWeight="semibold" fontSize="lg" color="fg.default">
                Notifications
              </Text>
              {unreadCount > 0 && (
                <Text fontSize="sm" color="fg.muted" mt="1">
                  {unreadCount} unread
                </Text>
              )}
            </Box>
            <Box maxHeight="500px" overflowY="auto">
              {notifications && notifications.length > 0 ? (
                <VStack align="stretch" gap="0">
                  {notifications.map((n) => (
                    <NotificationTeaser
                      key={n.id}
                      notification_id={n.id}
                      markAsRead={() => set_read(n, true)}
                      dismiss={() => dismiss(n)}
                    />
                  ))}
                </VStack>
              ) : (
                <Box textAlign="center" color="fg.muted" py="12">
                  <HiOutlineInbox size={32} style={{ margin: "0 auto 8px" }} />
                  <Text fontSize="sm">No notifications</Text>
                </Box>
              )}
            </Box>
          </PopoverBody>
        </PopoverContent>
      </PopoverRoot>
    </Box>
  );
}
