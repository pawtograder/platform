import { Tooltip } from "@/components/ui/tooltip";
import { useNotifications } from "@/hooks/useNotifications";
import { Badge, Box, IconButton, VStack, Text, Button, HStack, Link } from "@chakra-ui/react";
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverBody } from "@/components/ui/popover";
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { HiOutlineInbox } from "react-icons/hi2";
import NotificationTeaser, { SystemNotification } from "./notification-teaser";
import { useState, useEffect, useMemo } from "react";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import Markdown from "@/components/ui/markdown";

export default function NotificationsBox() {
  const { notifications, set_read, dismiss } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [modalNotifications, setModalNotifications] = useState<Notification[]>([]);
  const [bannerNotifications, setBannerNotifications] = useState<Notification[]>([]);
  const { role: classRole } = useClassProfiles();
  const course_id = classRole.class_id;

  // Filter out notifications where the author is the current user and separate by display mode
  const allFilteredNotifications = useMemo(
    () =>
      notifications?.filter((n) => {
        // Keep notifications without a body (if any exist)
        if (!n.body || typeof n.body !== "object") return true;

        const body = n.body as { author_profile_id?: string; type?: string; expires_at?: string };

        // Filter out expired system notifications
        if (body.type === "system" && body.expires_at) {
          const expiresAt = new Date(body.expires_at);
          const now = new Date();
          if (expiresAt < now) return false;
        }

        // Only filter out self-authored items when BOTH classRole is defined AND the notification has a defined author_profile_id
        if (classRole && body.author_profile_id) {
          return (
            body.author_profile_id !== classRole.private_profile_id &&
            body.author_profile_id !== classRole.public_profile_id
          );
        }

        // If classRole is undefined or author_profile_id is undefined, allow the item
        return true;
      }) || [],
    [notifications, classRole]
  );

  // Separate notifications by display mode
  const defaultNotifications = useMemo(
    () =>
      allFilteredNotifications.filter((n) => {
        if (!n.body || typeof n.body !== "object") return true;
        const body = n.body as { type?: string; display?: string };
        return body.type !== "system" || (body as SystemNotification).display === "default";
      }),
    [allFilteredNotifications]
  );

  const modalSystemNotifications = useMemo(
    () =>
      allFilteredNotifications.filter((n) => {
        if (!n.body || typeof n.body !== "object") return false;
        const body = n.body as { type?: string; display?: string };
        return body.type === "system" && (body as SystemNotification).display === "modal";
      }),
    [allFilteredNotifications]
  );

  const bannerSystemNotifications = useMemo(
    () =>
      allFilteredNotifications.filter((n) => {
        if (!n.body || typeof n.body !== "object") return false;
        const body = n.body as { type?: string; display?: string };
        return body.type === "system" && (body as SystemNotification).display === "banner";
      }),
    [allFilteredNotifications]
  );

  const unreadCount = useMemo(
    () => defaultNotifications?.filter((n) => !n.viewed_at).length || 0,
    [defaultNotifications]
  );

  // Manage modal notifications - show unread ones, dismiss after being marked as read
  useEffect(() => {
    const unreadModals = modalSystemNotifications.filter((n) => !n.viewed_at);
    setModalNotifications(unreadModals);
  }, [modalSystemNotifications]);

  // Manage banner notifications - show unread ones
  useEffect(() => {
    const unreadBanners = bannerSystemNotifications.filter((n) => !n.viewed_at);
    setBannerNotifications(unreadBanners);
  }, [bannerSystemNotifications]);

  /**
   * Marks all unread notifications as read
   */
  const markAllAsRead = async () => {
    if (!defaultNotifications) return;

    const unreadNotifications = defaultNotifications.filter((n) => !n.viewed_at);
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
                  <Link href={`/course/${course_id}/notifications`} color="fg.muted" mt="1">
                    View all
                  </Link>
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
              {defaultNotifications && defaultNotifications.length > 0 ? (
                <VStack align="stretch" gap="0">
                  {defaultNotifications.map((n) => (
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

      {/* Modal System Notifications */}
      {modalNotifications.length > 0 &&
        (() => {
          const notification = modalNotifications[0];
          const body = notification.body as SystemNotification;

          const handleModalDismiss = () => {
            set_read(notification, true);
            setModalNotifications((prev) => prev.filter((n) => n.id !== notification.id));
          };

          return (
            <DialogRoot
              key={notification.id}
              open={true}
              onOpenChange={body.backdrop_dismiss !== false ? handleModalDismiss : undefined}
              size="md"
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{body.title}</DialogTitle>
                </DialogHeader>
                <DialogBody>
                  <Markdown>{body.message}</Markdown>
                </DialogBody>
                <DialogFooter>
                  <Button variant="solid" onClick={handleModalDismiss} colorPalette="green">
                    OK
                  </Button>
                </DialogFooter>
              </DialogContent>
            </DialogRoot>
          );
        })()}

      {/* Banner System Notifications */}
      {bannerNotifications.length > 0 && (
        <Box position="relative">
          <PopoverRoot open={true} positioning={{ placement: "bottom-end" }}>
            <PopoverTrigger asChild>
              <Box />
            </PopoverTrigger>
            <PopoverContent shadow="lg" borderRadius="lg" borderWidth="1px" portalled={false}>
              <PopoverBody p="0">
                <VStack align="stretch" gap="0">
                  {bannerNotifications.map((notification) => {
                    const body = notification.body as SystemNotification;

                    // Determine background color based on severity
                    const severityBg = {
                      info: "blue.50",
                      success: "green.50",
                      warning: "orange.50",
                      error: "red.50"
                    };

                    return (
                      <Box
                        key={notification.id}
                        p="4"
                        borderBottom={bannerNotifications.length > 1 ? "1px" : "0"}
                        borderColor="border.subtle"
                        bg={severityBg[body.severity || "info"]}
                      >
                        <HStack justify="space-between" align="flex-start" gap="4">
                          <VStack align="flex-start" gap="2" flex="1">
                            <Text fontWeight="semibold" fontSize="sm" color="fg.default">
                              {body.title}
                            </Text>
                            <Markdown style={{ fontSize: "0.875rem", color: "var(--chakra-colors-fg-default)" }}>
                              {body.message}
                            </Markdown>
                          </VStack>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette={
                              body.severity === "success"
                                ? "green"
                                : body.severity === "warning"
                                  ? "orange"
                                  : body.severity === "error"
                                    ? "red"
                                    : "blue"
                            }
                            onClick={() => {
                              set_read(notification, true);
                              setBannerNotifications((prev) => prev.filter((n) => n.id !== notification.id));
                            }}
                          >
                            Dismiss
                          </Button>
                        </HStack>
                      </Box>
                    );
                  })}
                </VStack>
              </PopoverBody>
            </PopoverContent>
          </PopoverRoot>
        </Box>
      )}
    </Box>
  );
}
