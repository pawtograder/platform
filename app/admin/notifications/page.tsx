"use client";

import { Button } from "@/components/ui/button";
import { Bell, Plus } from "lucide-react";
import { Card, Text, Flex, Grid, HStack, VStack, Heading, Badge } from "@chakra-ui/react";
import CreateNotificationModal from "./CreateNotificationModal";
import NotificationsTable from "./NotificationsTable";
import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

interface NotificationStats {
  total_notifications: number;
  active_notifications: number;
  notifications_by_severity: Record<string, number>;
  notifications_by_display: Record<string, number>;
}

interface RawNotificationStatsResponse {
  total_notifications?: number;
  active_notifications?: number;
  notifications_by_severity?: unknown;
  notifications_by_display?: unknown;
}

/**
 * System notifications management page for admins
 */
export default function NotificationsPage() {
  const [stats, setStats] = useState<NotificationStats>({
    total_notifications: 0,
    active_notifications: 0,
    notifications_by_severity: {},
    notifications_by_display: {}
  });
  const [isLoadingStats, setIsLoadingStats] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase.rpc("get_system_notification_stats");

        if (error) throw error;

        const statsData = Array.isArray(data) ? data[0] : data;
        const rawStats = statsData as RawNotificationStatsResponse;
        setStats({
          total_notifications: rawStats?.total_notifications || 0,
          active_notifications: rawStats?.active_notifications || 0,
          notifications_by_severity: (rawStats?.notifications_by_severity as Record<string, number>) || {},
          notifications_by_display: (rawStats?.notifications_by_display as Record<string, number>) || {}
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error fetching notification stats:", error);
      } finally {
        setIsLoadingStats(false);
      }
    }

    fetchStats();
  }, []);

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">System Notifications</Heading>
          <Text color="fg.muted">Create and manage system-wide notifications for users</Text>
        </VStack>
        <CreateNotificationModal>
          <Button>
            <HStack gap={2}>
              <Plus size={16} />
              <Text>Create Notification</Text>
            </HStack>
          </Button>
        </CreateNotificationModal>
      </Flex>

      {/* Stats Cards */}
      <Grid templateColumns="repeat(auto-fit, minmax(250px, 1fr))" gap={4}>
        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                Total Notifications
              </Text>
              <Bell size={16} color="var(--chakra-colors-gray-500)" />
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold">
              {isLoadingStats ? "..." : stats.total_notifications}
            </Text>
            <Text fontSize="xs" color="fg.subtle">
              All system notifications
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="medium">
                Active Notifications
              </Text>
              <Badge variant="solid" colorPalette="green" size="xs">
                LIVE
              </Badge>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Text fontSize="2xl" fontWeight="bold" color="green.600">
              {isLoadingStats ? "..." : stats.active_notifications}
            </Text>
            <Text fontSize="xs" color="fg.subtle">
              Currently visible to users
            </Text>
          </Card.Body>
        </Card.Root>
      </Grid>

      {/* Notifications Table */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Recent Notifications</Card.Title>
          <Text color="fg.muted">Manage system notifications</Text>
        </Card.Header>
        <Card.Body>
          <NotificationsTable />
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
