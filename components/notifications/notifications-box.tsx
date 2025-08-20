import { Tooltip } from "@/components/ui/tooltip";
import { useNotifications } from "@/hooks/useNotifications";
import { Badge, Box, IconButton, VStack, Text, Button, HStack } from "@chakra-ui/react";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverBody } from "@/components/ui/popover";
import { HiOutlineInbox } from "react-icons/hi2";
import NotificationTeaser from "./notification-teaser";
import { useState } from "react";
import { useClassProfiles } from "@/hooks/useClassProfiles";

export default function NotificationsBox() {
  const { notifications, set_read, dismiss } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const { role: classRole } = useClassProfiles();

  // Filter out notifications where the author is the current user
  const filteredNotifications =
    notifications?.filter((n) => {
      // Keep notifications without a body (if any exist)
      if (!n.body || typeof n.body !== "object") return true;

      // Filter out notifications where the author is the current user
      const body = n.body as { author_profile_id?: string };
      return (
        body.author_profile_id !== classRole.private_profile_id &&
        body.author_profile_id !== classRole.public_profile_id
      );
    }) || [];
  const unreadCount = filteredNotifications?.filter((n) => !n.viewed_at).length || 0;

  /**
   * Marks all unread notifications as read
   */
  const markAllAsRead = async () => {
    if (!filteredNotifications) return;

    const unreadNotifications = filteredNotifications.filter((n) => !n.viewed_at);
    const promises = unreadNotifications.map((notification) => set_read(notification, true));

    try {
      await Promise.all(promises);
    } catch {
      // Individual notification update failures are handled by the set_read function
    }
  };

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
              <HStack justify="space-between" align="center">
                <Box>
                  <Text fontWeight="semibold" fontSize="lg" color="fg.default">
                    Notifications
                  </Text>
                  {unreadCount > 0 && (
                    <Text fontSize="sm" color="fg.muted" mt="1">
                      {unreadCount} unread
                    </Text>
                  )}
                </Box>
                {unreadCount > 1 && (
                  <Button size="xs" variant="ghost" colorPalette="blue" onClick={markAllAsRead}>
                    Mark all as read
                  </Button>
                )}
              </HStack>
            </Box>
            <Box maxHeight="500px" overflowY="auto">
              {filteredNotifications && filteredNotifications.length > 0 ? (
                <VStack align="stretch" gap="0">
                  {filteredNotifications.map((n) => (
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
