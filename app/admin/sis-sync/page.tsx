"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { VStack, HStack, Text, Heading, Card, Badge, Table, Box, Flex } from "@chakra-ui/react";
import { RefreshCw, Clock, AlertCircle, CheckCircle, Database } from "lucide-react";

interface SISClass {
  class_id: number;
  class_name: string;
  term: string;
  year: number;
  sis_sections_count: number;
  last_sync_attempt: string | null;
  sync_enabled: boolean;
  total_invitations: number;
  pending_invitations: number;
  expired_invitations: number;
}

export default function SISSyncPage() {
  const [classes, setClasses] = useState<SISClass[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncingClassId, setSyncingClassId] = useState<number | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  const supabase = createClient();

  const loadSISStatus = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase.rpc("admin_get_sis_sync_status");

      if (error) throw error;
      setClasses((data as SISClass[]) || []);
    } catch (error) {
      toaster.create({
        title: "Error loading SIS status",
        description: error instanceof Error ? error.message : "Failed to load data",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const triggerSync = async (classId?: number) => {
    if (classId) {
      setSyncingClassId(classId);
    } else {
      setSyncingAll(true);
    }

    try {
      const { error } = await supabase.rpc("admin_trigger_sis_sync", {
        p_class_id: classId || undefined
      });

      if (error) throw error;

      toaster.create({
        title: "SIS Sync Triggered",
        description: classId ? `Sync started for class ID ${classId}` : "Sync started for all SIS-linked classes",
        type: "success"
      });

      // Reload status after a brief delay
      setTimeout(loadSISStatus, 2000);
    } catch (error) {
      toaster.create({
        title: "Sync Error",
        description: error instanceof Error ? error.message : "Failed to trigger sync",
        type: "error"
      });
    } finally {
      setSyncingClassId(null);
      setSyncingAll(false);
    }
  };

  const toggleSyncEnabled = async (classId: number, enabled: boolean) => {
    try {
      const { error } = await supabase.rpc("admin_set_sis_sync_enabled", {
        p_class_id: classId,
        p_enabled: enabled
      });

      if (error) throw error;

      toaster.create({
        title: "Sync Status Updated",
        description: `SIS sync ${enabled ? "enabled" : "disabled"} for class`,
        type: "success"
      });

      loadSISStatus();
    } catch (error) {
      toaster.create({
        title: "Update Error",
        description: error instanceof Error ? error.message : "Failed to update sync status",
        type: "error"
      });
    }
  };

  useEffect(() => {
    loadSISStatus();
  }, []);

  const formatLastSync = (dateString: string | null) => {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diffMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));

    if (diffMinutes < 60) {
      return `${diffMinutes} minutes ago`;
    } else if (diffMinutes < 1440) {
      return `${Math.floor(diffMinutes / 60)} hours ago`;
    } else {
      return `${Math.floor(diffMinutes / 1440)} days ago`;
    }
  };

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">SIS Enrollment Sync</Heading>
          <Text color="fg.muted">Monitor and manage automatic enrollment synchronization with SIS</Text>
        </VStack>
        <HStack gap={3}>
          <Button variant="outline" onClick={loadSISStatus} loading={isLoading}>
            <HStack gap={2}>
              <RefreshCw size={16} />
              <Text>Refresh Status</Text>
            </HStack>
          </Button>
          <Button onClick={() => triggerSync()} loading={syncingAll} colorScheme="blue">
            <HStack gap={2}>
              <Database size={16} />
              <Text>Sync All Classes</Text>
            </HStack>
          </Button>
        </HStack>
      </Flex>

      {/* Sync Overview */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Sync Overview</Card.Title>
          <Text color="fg.muted">Automatic sync runs hourly at :15 minutes past each hour</Text>
        </Card.Header>
        <Card.Body>
          <HStack gap={8}>
            <VStack gap={2}>
              <HStack gap={2}>
                <Database size={20} />
                <Text fontWeight="semibold">Total SIS Classes</Text>
              </HStack>
              <Text fontSize="2xl" fontWeight="bold" color="blue.fg">
                {classes.length}
              </Text>
            </VStack>
            <VStack gap={2}>
              <HStack gap={2}>
                <CheckCircle size={20} />
                <Text fontWeight="semibold">Sync Enabled</Text>
              </HStack>
              <Text fontSize="2xl" fontWeight="bold" color="green.500">
                {classes.filter((c) => c.sync_enabled).length}
              </Text>
            </VStack>
            <VStack gap={2}>
              <HStack gap={2}>
                <AlertCircle size={20} />
                <Text fontWeight="semibold">Sync Disabled</Text>
              </HStack>
              <Text fontSize="2xl" fontWeight="bold" color="orange.fg">
                {classes.filter((c) => !c.sync_enabled).length}
              </Text>
            </VStack>
            <VStack gap={2}>
              <HStack gap={2}>
                <Clock size={20} />
                <Text fontWeight="semibold">Total Sections</Text>
              </HStack>
              <Text fontSize="2xl" fontWeight="bold" color="purple.fg">
                {classes.reduce((sum, c) => sum + c.sis_sections_count, 0)}
              </Text>
            </VStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* SIS Classes Table */}
      <Card.Root>
        <Card.Header>
          <Card.Title>SIS-Linked Classes</Card.Title>
          <Text color="fg.muted">Classes with sections imported from SIS that support automatic sync</Text>
        </Card.Header>
        <Card.Body>
          {isLoading ? (
            <Box textAlign="center" py={8}>
              <Text>Loading SIS sync status...</Text>
            </Box>
          ) : classes.length === 0 ? (
            <Box textAlign="center" py={8}>
              <Text color="fg.subtle">No SIS-linked classes found.</Text>
              <Text fontSize="sm" color="fg.subtle" mt={2}>
                Import a course from SIS to see sync status here.
              </Text>
            </Box>
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Class</Table.ColumnHeader>
                  <Table.ColumnHeader>Term</Table.ColumnHeader>
                  <Table.ColumnHeader>SIS Sections</Table.ColumnHeader>
                  <Table.ColumnHeader>Invitations</Table.ColumnHeader>
                  <Table.ColumnHeader>Sync Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Last Sync</Table.ColumnHeader>
                  <Table.ColumnHeader>Actions</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {classes.map((class_) => (
                  <Table.Row key={class_.class_id}>
                    <Table.Cell>
                      <Text fontWeight="medium">{class_.class_name}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontWeight="medium">
                        {class_.term} {class_.year}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge colorPalette="blue">{class_.sis_sections_count} sections</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <VStack align="start" gap={1}>
                        {class_.pending_invitations > 0 && (
                          <Badge size="sm" colorPalette="orange">
                            {class_.pending_invitations} pending
                          </Badge>
                        )}
                        {class_.expired_invitations > 0 && (
                          <Badge size="sm" colorPalette="red">
                            {class_.expired_invitations} expired
                          </Badge>
                        )}
                        {class_.total_invitations === 0 && (
                          <Text fontSize="sm" color="fg.subtle">
                            None
                          </Text>
                        )}
                      </VStack>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge
                        colorPalette={class_.sync_enabled ? "green" : "orange"}
                        variant={class_.sync_enabled ? "solid" : "outline"}
                      >
                        {class_.sync_enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="sm" color="fg.muted">
                        {formatLastSync(class_.last_sync_attempt)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack gap={2}>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => triggerSync(class_.class_id)}
                          loading={syncingClassId === class_.class_id}
                        >
                          <HStack gap={1}>
                            <RefreshCw size={14} />
                            <Text>Sync Now</Text>
                          </HStack>
                        </Button>
                        <Button
                          size="sm"
                          variant={class_.sync_enabled ? "outline" : "solid"}
                          colorScheme={class_.sync_enabled ? "orange" : "green"}
                          onClick={() => toggleSyncEnabled(class_.class_id, !class_.sync_enabled)}
                        >
                          {class_.sync_enabled ? "Disable" : "Enable"}
                        </Button>
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Card.Body>
      </Card.Root>

      {/* Sync Information */}
      <Card.Root>
        <Card.Header>
          <Card.Title>How SIS Sync Works</Card.Title>
        </Card.Header>
        <Card.Body>
          <VStack align="start" gap={3}>
            <Text>
              <strong>Automatic Sync:</strong> Runs every hour at :15 minutes past the hour for all enabled classes
            </Text>
            <Text>
              <strong>Manual Sync:</strong> Click "Sync Now" to immediately sync a specific class
            </Text>
            <Text>
              <strong>Sync Process:</strong>
            </Text>
            <VStack align="start" gap={1} pl={4}>
              <Text fontSize="sm">• Fetches current enrollment from SIS API for each section</Text>
              <Text fontSize="sm">• Creates invitations for new students not yet in the system</Text>
              <Text fontSize="sm">• Updates section metadata if changed in SIS</Text>
              <Text fontSize="sm">• Preserves existing enrollments and user data</Text>
            </VStack>
            <Box p={3} bg="blue.subtle" rounded="md" w="full">
              <HStack gap={2}>
                <AlertCircle size={16} />
                <Text fontSize="sm" fontWeight="medium">
                  Note: Disabled classes are excluded from automatic sync but can be manually synced
                </Text>
              </HStack>
            </Box>
          </VStack>
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
