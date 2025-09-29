"use client";

import NotificationTeaser from "@/components/notifications/notification-teaser";
import { toaster } from "@/components/ui/toaster";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useNotifications } from "@/hooks/useNotifications";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Button, HStack, IconButton, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { useParams, useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { useMemo } from "react";
import { FaExternalLinkAlt, FaTrash } from "react-icons/fa";

function getType(n: Notification): string {
  const body = n.body && typeof n.body === "object" ? (n.body as { type?: string }) : undefined;
  return body?.type ?? "unknown";
}

// Minimal body types for local parsing (avoid using any)
type HelpRequestMessageBody = {
  type: "help_request_message";
  help_request_id?: number;
  help_queue_id?: number;
  help_queue_name?: string;
  author_name?: string;
  message_preview?: string;
};

type HelpRequestBody = {
  type: "help_request";
  help_request_id?: number;
  help_queue_id?: number;
  help_queue_name?: string;
  creator_name?: string;
  assignee_name?: string;
  status?: string;
  request_preview?: string;
  action?: "created" | "status_changed" | "assigned";
};

type DiscussionBody = {
  type: "discussion_thread";
  root_thread_id: number;
  new_comment_number?: number;
  reply_author_name?: string;
  teaser?: string;
};

// Keeping getSystemField around if we later reintroduce system columns
// function getSystemField<T extends string>(n: Notification, field: "display" | "severity"): T | undefined {
//   const body = n.body && typeof n.body === "object" ? (n.body as Record<string, unknown>) : undefined;
//   if (!body || body["type"] !== "system") return undefined;
//   return body[field] as T | undefined;
// }

export default function NotificationsTable() {
  const { notifications, set_read, dismiss, mark_all_read, delete_all } = useNotifications();
  const { course_id } = useParams();
  const router = useRouter();

  const isLoading = notifications === undefined;

  const officeHoursMessages = useMemo(
    () => (notifications || []).filter((n) => getType(n) === "help_request_message" || getType(n) === "help_request"),
    [notifications]
  );
  const discussion = useMemo(
    () => (notifications || []).filter((n) => getType(n) === "discussion_thread"),
    [notifications]
  );
  const other = useMemo(
    () =>
      (notifications || []).filter(
        (n) => !["help_request", "help_request_message", "discussion_thread"].includes(getType(n))
      ),
    [notifications]
  );

  function openHelpRequest(n: Notification) {
    try {
      const body = (n.body || {}) as Partial<HelpRequestBody | HelpRequestMessageBody>;
      const popOutUrl = `/course/${course_id}/office-hours/request/${String(body.help_request_id ?? "")}?popout=true`;
      const newWindow = window.open(
        popOutUrl,
        `help-request-chat-${String(body.help_request_id ?? "")}`,
        "width=800,height=600,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no"
      );
      if (newWindow) {
        newWindow.focus();
        newWindow.addEventListener("load", () => {
          const windowTitle = `Help Request #${String(body.help_request_id ?? "")} - ${String(body.help_queue_name ?? "")}`;
          newWindow.document.title = windowTitle;
        });
      } else {
        toaster.error({ title: "Pop-out blocked", description: "Enable pop-ups to open help request." });
      }
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({ title: "Failed to open", description: e instanceof Error ? e.message : String(e) });
    }
  }

  function openDiscussion(n: Notification) {
    try {
      const body = (n.body || {}) as Partial<DiscussionBody>;
      const replyIdx = body.new_comment_number ? `#post-${body.new_comment_number}` : "";
      const url = `/course/${course_id}/discussion/${String(body.root_thread_id ?? "")}${replyIdx}`;
      router.push(url);
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({ title: "Failed to open", description: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <VStack w="100%" align="stretch" gap={6} p={4}>
      <HStack justify="space-between" w="100%">
        <Text fontSize="lg" fontWeight="semibold">
          Notifications
        </Text>
        <HStack gap={2}>
          <Button
            size="sm"
            variant="subtle"
            colorPalette="green"
            onClick={() => mark_all_read(notifications || [])}
            disabled={isLoading || !notifications?.some((n) => !n.viewed_at)}
          >
            Mark all as read
          </Button>
          <PopConfirm
            triggerLabel="Delete all notifications"
            trigger={
              <Button size="sm" variant="ghost" colorPalette="red" disabled={isLoading || !notifications?.length}>
                Delete all
              </Button>
            }
            confirmHeader="Delete all notifications"
            confirmText="Are you sure you want to delete all notifications? This action cannot be undone."
            onConfirm={() => delete_all(notifications || [])}
          />
        </HStack>
      </HStack>

      {/* Office Hours */}
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Text fontSize="md" fontWeight="semibold">
            Office Hours
          </Text>
          <HStack gap={2}>
            <Text color="fg.muted">{officeHoursMessages.length} items</Text>
            <Button
              size="xs"
              variant="subtle"
              colorPalette="green"
              onClick={() => mark_all_read(officeHoursMessages)}
              disabled={isLoading || !officeHoursMessages.some((n) => !n.viewed_at)}
            >
              Mark all as read
            </Button>
            <PopConfirm
              triggerLabel="Delete all office hours notifications"
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  colorPalette="red"
                  disabled={isLoading || !officeHoursMessages.length}
                >
                  Delete all
                </Button>
              }
              confirmHeader="Delete all office hours notifications"
              confirmText="Are you sure you want to delete all office hours notifications? This action cannot be undone."
              onConfirm={() => delete_all(officeHoursMessages)}
            />
          </HStack>
        </HStack>
        <Box overflowX="auto">
          <Table.Root minW="0" w="100%">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader bg="bg.muted">When</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Queue</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">User</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Message</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted" textAlign="right">
                  Actions
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {isLoading ? (
                <Table.Row>
                  <Table.Cell colSpan={5} bg="bg.subtle">
                    <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                      <Spinner size="lg" />
                      <Text>Loading...</Text>
                    </VStack>
                  </Table.Cell>
                </Table.Row>
              ) : officeHoursMessages.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <Text color="fg.muted">No office hours notifications</Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                officeHoursMessages.map((n) => {
                  const b = (n.body || {}) as Partial<HelpRequestMessageBody | HelpRequestBody>;
                  const isHelpRequest = b.type === "help_request";
                  const whoReplied = isHelpRequest
                    ? (b as Partial<HelpRequestBody>).creator_name ||
                      (b as Partial<HelpRequestBody>).assignee_name ||
                      ""
                    : (b as Partial<HelpRequestMessageBody>).author_name || "";
                  const messageText = isHelpRequest
                    ? (b as Partial<HelpRequestBody>).request_preview || ""
                    : (b as Partial<HelpRequestMessageBody>).message_preview || "";

                  return (
                    <Table.Row key={n.id} bg={!n.viewed_at ? "blue.subtle" : undefined}>
                      <Table.Cell>
                        <Text color="fg.muted">
                          {n.created_at ? formatDistanceToNow(new Date(n.created_at), { addSuffix: true }) : ""}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text>{b.help_queue_name || ""}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontWeight="medium">{whoReplied}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text lineClamp={2} color="fg.muted">
                          {messageText}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack justifyContent="flex-end" gap={2}>
                          <Button size="xs" variant="ghost" colorPalette="blue" onClick={() => openHelpRequest(n)}>
                            Open <FaExternalLinkAlt style={{ marginLeft: 6 }} />
                          </Button>
                          {!n.viewed_at && (
                            <Button size="xs" variant="subtle" colorPalette="green" onClick={() => set_read(n, true)}>
                              Mark read
                            </Button>
                          )}
                          <IconButton
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            aria-label="Dismiss"
                            onClick={() => dismiss(n)}
                          >
                            <FaTrash />
                          </IconButton>
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  );
                })
              )}
            </Table.Body>
          </Table.Root>
        </Box>
      </VStack>

      {/* Discussion Threads */}
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Text fontSize="md" fontWeight="semibold">
            Discussion Threads
          </Text>
          <HStack gap={2}>
            <Text color="fg.muted">{discussion.length} items</Text>
            <Button
              size="xs"
              variant="subtle"
              colorPalette="green"
              onClick={() => mark_all_read(discussion)}
              disabled={isLoading || !discussion.some((n) => !n.viewed_at)}
            >
              Mark all as read
            </Button>
            <PopConfirm
              triggerLabel="Delete all discussion notifications"
              trigger={
                <Button size="xs" variant="ghost" colorPalette="red" disabled={isLoading || !discussion.length}>
                  Delete all
                </Button>
              }
              confirmHeader="Delete all discussion notifications"
              confirmText="Are you sure you want to delete all discussion notifications? This action cannot be undone."
              onConfirm={() => delete_all(discussion)}
            />
          </HStack>
        </HStack>
        <Box overflowX="auto">
          <Table.Root minW="0" w="100%">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader bg="bg.muted">When</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Type</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Who</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Teaser</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted" textAlign="right">
                  Actions
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {isLoading ? (
                <Table.Row>
                  <Table.Cell colSpan={5} bg="bg.subtle">
                    <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                      <Spinner size="lg" />
                      <Text>Loading...</Text>
                    </VStack>
                  </Table.Cell>
                </Table.Row>
              ) : discussion.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <Text color="fg.muted">No discussion notifications</Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                discussion.map((n) => {
                  const b = (n.body || {}) as Partial<DiscussionBody>;
                  const kind = b.new_comment_number && b.new_comment_number > 1 ? "replied" : "new post";
                  return (
                    <Table.Row key={n.id} bg={!n.viewed_at ? "blue.subtle" : undefined}>
                      <Table.Cell>
                        <Text color="fg.muted">
                          {n.created_at ? formatDistanceToNow(new Date(n.created_at), { addSuffix: true }) : ""}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge variant="subtle" colorPalette={kind === "replied" ? "blue" : "green"}>
                          {kind}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontWeight="medium">{b.reply_author_name || ""}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text lineClamp={2} color="fg.muted">
                          {b.teaser || ""}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack justifyContent="flex-end" gap={2}>
                          <Button size="xs" variant="ghost" colorPalette="blue" onClick={() => openDiscussion(n)}>
                            Open <FaExternalLinkAlt style={{ marginLeft: 6 }} />
                          </Button>
                          {!n.viewed_at && (
                            <Button size="xs" variant="subtle" colorPalette="green" onClick={() => set_read(n, true)}>
                              Mark read
                            </Button>
                          )}
                          <IconButton
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            aria-label="Dismiss"
                            onClick={() => dismiss(n)}
                          >
                            <FaTrash />
                          </IconButton>
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  );
                })
              )}
            </Table.Body>
          </Table.Root>
        </Box>
      </VStack>

      {/* Other */}
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Text fontSize="md" fontWeight="semibold">
            Other
          </Text>
          <HStack gap={2}>
            <Text color="fg.muted">{other.length} items</Text>
            <Button
              size="xs"
              variant="subtle"
              colorPalette="green"
              onClick={() => mark_all_read(other)}
              disabled={isLoading || !other.some((n) => !n.viewed_at)}
            >
              Mark all as read
            </Button>
            <PopConfirm
              triggerLabel="Delete all other notifications"
              trigger={
                <Button size="xs" variant="ghost" colorPalette="red" disabled={isLoading || !other.length}>
                  Delete all
                </Button>
              }
              confirmHeader="Delete all other notifications"
              confirmText="Are you sure you want to delete all other notifications? This action cannot be undone."
              onConfirm={() => delete_all(other)}
            />
          </HStack>
        </HStack>
        <Box overflowX="auto">
          <Table.Root minW="0" w="100%">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader bg="bg.muted">When</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Type</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted">Teaser</Table.ColumnHeader>
                <Table.ColumnHeader bg="bg.muted" textAlign="right">
                  Actions
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {isLoading ? (
                <Table.Row>
                  <Table.Cell colSpan={4} bg="bg.subtle">
                    <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                      <Spinner size="lg" />
                      <Text>Loading...</Text>
                    </VStack>
                  </Table.Cell>
                </Table.Row>
              ) : other.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <Text color="fg.muted">No other notifications</Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                other.map((n) => (
                  <Table.Row key={n.id} bg={!n.viewed_at ? "blue.subtle" : undefined}>
                    <Table.Cell>
                      <Text color="fg.muted">
                        {n.created_at ? formatDistanceToNow(new Date(n.created_at), { addSuffix: true }) : ""}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge variant="subtle" colorPalette="gray">
                        {getType(n)}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <NotificationTeaser
                        notification_id={n.id}
                        markAsRead={() => set_read(n, true)}
                        dismiss={() => dismiss(n)}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <HStack justifyContent="flex-end" gap={2}>
                        {!n.viewed_at && (
                          <Button size="xs" variant="subtle" colorPalette="green" onClick={() => set_read(n, true)}>
                            Mark read
                          </Button>
                        )}
                        <IconButton
                          size="xs"
                          variant="ghost"
                          colorPalette="red"
                          aria-label="Dismiss"
                          onClick={() => dismiss(n)}
                        >
                          <FaTrash />
                        </IconButton>
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))
              )}
            </Table.Body>
          </Table.Root>
        </Box>
      </VStack>
    </VStack>
  );
}
