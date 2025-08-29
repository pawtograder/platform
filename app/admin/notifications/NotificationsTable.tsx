"use client";

import type { SystemNotification } from "@/components/notifications/notification-teaser";
import { toaster } from "@/components/ui/toaster";
import { Badge, Box, HStack, IconButton, Text, VStack, Table } from "@chakra-ui/react";
import { Eye, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useNotificationsTable } from "@/hooks/useNotificationsTable";
import { Button } from "@/components/ui/button";

export default function NotificationsTable() {
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const table = useNotificationsTable({ onDelete: handleDelete });

  async function handleDelete(notificationId: number) {
    if (deletingIds.has(notificationId)) return;

    const confirmed = confirm("Are you sure you want to delete this notification? This action cannot be undone.");
    if (!confirmed) return;

    setDeletingIds((prev) => new Set(prev).add(notificationId));

    try {
      const supabase = createClient();

      const { error } = await supabase.from("notifications").delete().eq("id", notificationId);

      if (error) {
        throw error;
      }

      // Refresh the table to remove the deleted row from the UI
      await table.controller.refetchAll();

      toaster.success({
        title: "Notification deleted",
        description: "The notification has been deleted successfully."
      });
    } catch (error) {
      toaster.error({
        title: "Failed to delete notification",
        description: (error as Error).message
      });
    } finally {
      setDeletingIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(notificationId);
        return newSet;
      });
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const getSeverityColor = (severity?: string) => {
    switch (severity) {
      case "success":
        return "green";
      case "warning":
        return "orange";
      case "error":
        return "red";
      default:
        return "blue";
    }
  };

  const getDisplayModeColor = (display: string) => {
    switch (display) {
      case "modal":
        return "purple";
      case "banner":
        return "teal";
      default:
        return "gray";
    }
  };

  const getAudienceText = (body: SystemNotification) => {
    if (!body.audience) return "All users";

    const parts: string[] = [];
    if (body.audience.roles?.length) {
      parts.push(`Roles: ${body.audience.roles.join(", ")}`);
    }
    if (body.audience.course_ids?.length) {
      parts.push(`Courses: ${body.audience.course_ids.join(", ")}`);
    }
    if (body.audience.user_ids?.length) {
      parts.push(`${body.audience.user_ids.length} specific users`);
    }

    return parts.length > 0 ? parts.join("; ") : "All users";
  };

  if (table.isLoading) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted">Loading notifications...</Text>
      </Box>
    );
  }

  if (!table.data.length) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted">No system notifications yet.</Text>
        <Text fontSize="sm" color="fg.subtle" mt={1}>
          Create your first notification to get started.
        </Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" gap={4}>
      <Table.Root size="sm">
        <Table.Header>
          {table.getHeaderGroups().map((headerGroup) => (
            <Table.Row key={headerGroup.id}>
              <Table.ColumnHeader>Notification</Table.ColumnHeader>
              <Table.ColumnHeader>Display</Table.ColumnHeader>
              <Table.ColumnHeader>Audience</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Created</Table.ColumnHeader>
              <Table.ColumnHeader>Actions</Table.ColumnHeader>
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {table.getRowModel().rows.map((row) => {
            const notification = row.original;
            const body = notification.body as SystemNotification;
            const isDeleting = deletingIds.has(notification.id);

            return (
              <Table.Row key={notification.id}>
                <Table.Cell>
                  <VStack align="start" gap={1}>
                    <HStack gap={2}>
                      {body.icon && <Text fontSize="sm">{body.icon}</Text>}
                      <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                        {body.title}
                      </Text>
                    </HStack>
                    <Text fontSize="xs" color="fg.muted" lineClamp={2} maxW="300px">
                      {body.message}
                    </Text>
                    <HStack gap={2}>
                      <Badge size="xs" colorPalette={getSeverityColor(body.severity)}>
                        {body.severity || "info"}
                      </Badge>
                      {body.persistent && (
                        <Badge size="xs" colorPalette="orange" variant="subtle">
                          Persistent
                        </Badge>
                      )}
                      {body.expires_at && (
                        <Badge size="xs" colorPalette="gray" variant="subtle">
                          Expires
                        </Badge>
                      )}
                    </HStack>
                  </VStack>
                </Table.Cell>
                <Table.Cell>
                  <Badge size="sm" colorPalette={getDisplayModeColor(body.display)}>
                    {body.display}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="xs" color="fg.muted" maxW="200px" lineClamp={2}>
                    {getAudienceText(body)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Badge
                    size="sm"
                    colorPalette={notification.viewed_at ? "gray" : "green"}
                    variant={notification.viewed_at ? "subtle" : "solid"}
                  >
                    {notification.viewed_at ? "Read" : "Active"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="xs" color="fg.muted">
                    {formatDate(notification.created_at)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <HStack gap={1}>
                    <IconButton
                      size="xs"
                      variant="ghost"
                      colorPalette="blue"
                      aria-label="View notification"
                      onClick={() => {
                        // Could implement a preview modal here
                        toaster.info({
                          title: body.title,
                          description: body.message
                        });
                      }}
                    >
                      <Eye size={14} />
                    </IconButton>
                    <IconButton
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      aria-label="Delete notification"
                      onClick={() => handleDelete(notification.id)}
                      loading={isDeleting}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </HStack>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>

      {/* Pagination Controls */}
      <HStack justify="space-between" align="center">
        <Text fontSize="sm" color="fg.muted">
          Showing {table.getRowModel().rows.length} of {table.getFilteredRowModel().rows.length} notifications
        </Text>
        <HStack gap={2}>
          <Button variant="ghost" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft size={16} />
            Previous
          </Button>
          <Text fontSize="sm" color="fg.muted">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </Text>
          <Button variant="ghost" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
            <ChevronRight size={16} />
          </Button>
        </HStack>
      </HStack>
    </VStack>
  );
}
