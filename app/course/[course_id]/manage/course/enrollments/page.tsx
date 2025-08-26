"use client";

import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import {
  Box,
  Container,
  Heading,
  HStack,
  List,
  Text,
  Badge,
  Flex,
  Collapsible,
  Icon,
  Accordion
} from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AddSingleCourseMember from "./addSingleCourseMember";
import EnrollmentsTable from "./enrollmentsTable";
import ImportStudentsCSVModal from "./importStudentsCSVModal";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
type ClassWithSyncStatus = GetResult<
  Database["public"],
  Database["public"]["Tables"]["classes"]["Row"],
  "classes",
  Database["public"]["Tables"]["classes"]["Relationships"],
  "*, class_sections(*), lab_sections(*), sis_sync_status(*)"
>;

type SisSyncStatus = Database["public"]["Tables"]["sis_sync_status"]["Row"];

function SyncStatusIndicator({ syncStatus }: { syncStatus: SisSyncStatus }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if sync is healthy (enabled, successful, and within 90 minutes)
  const isHealthy = () => {
    if (!syncStatus.sync_enabled || !syncStatus.last_sync_time) return false;

    const lastSyncTime = new Date(syncStatus.last_sync_time);
    const now = new Date();
    const minutesAgo = (now.getTime() - lastSyncTime.getTime()) / (1000 * 60);

    return syncStatus.last_sync_status === "success" && minutesAgo <= 90;
  };

  const getStatusIcon = () => {
    if (!syncStatus.sync_enabled) {
      return (
        <Icon color="fg.muted">
          <XCircle size={16} />
        </Icon>
      );
    }

    if (isHealthy()) {
      return (
        <Icon color="green.500">
          <CheckCircle size={16} />
        </Icon>
      );
    }

    if (syncStatus.last_sync_status === "error" || syncStatus.last_sync_status === "failed") {
      return (
        <Icon color="red.500">
          <XCircle size={16} />
        </Icon>
      );
    }

    return (
      <Icon color="yellow.500">
        <AlertCircle size={16} />
      </Icon>
    );
  };

  const getStatusBadge = () => {
    if (!syncStatus.sync_enabled) {
      return (
        <Badge variant="subtle" size="sm">
          Disabled
        </Badge>
      );
    }

    if (isHealthy()) {
      return (
        <Badge colorPalette="green" size="sm">
          Synced
        </Badge>
      );
    }

    if (syncStatus.last_sync_status === "error" || syncStatus.last_sync_status === "failed") {
      return (
        <Badge colorPalette="red" size="sm">
          Error
        </Badge>
      );
    }

    return (
      <Badge colorPalette="yellow" size="sm">
        Pending
      </Badge>
    );
  };

  const formatLastSyncTime = () => {
    if (!syncStatus.last_sync_time) return "Never";

    const lastSyncTime = new Date(syncStatus.last_sync_time);
    const now = new Date();
    const minutesAgo = Math.floor((now.getTime() - lastSyncTime.getTime()) / (1000 * 60));

    if (minutesAgo < 60) {
      return `${minutesAgo} minutes ago`;
    } else if (minutesAgo < 1440) {
      const hoursAgo = Math.floor(minutesAgo / 60);
      return `${hoursAgo} hour${hoursAgo > 1 ? "s" : ""} ago`;
    } else {
      const daysAgo = Math.floor(minutesAgo / 1440);
      return `${daysAgo} day${daysAgo > 1 ? "s" : ""} ago`;
    }
  };

  return (
    <Box ml={2} mt={1}>
      <Flex
        align="center"
        gap={2}
        cursor="pointer"
        onClick={() => setIsExpanded(!isExpanded)}
        _hover={{ bg: "bg.muted" }}
        p={1}
        borderRadius="sm"
      >
        {getStatusIcon()}
        {getStatusBadge()}
        <Text fontSize="xs" color="fg.muted">
          Last sync: {formatLastSyncTime()}
        </Text>
        <Icon color="fg.subtle">{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</Icon>
      </Flex>

      <Collapsible.Root open={isExpanded}>
        <Collapsible.Content>
          <Box ml={6} mt={2} p={2} bg="bg.muted" borderRadius="sm" fontSize="xs">
            <Text>
              <strong>Status:</strong> {syncStatus.last_sync_status || "Unknown"}
            </Text>
            <Text>
              <strong>Enabled:</strong> {syncStatus.sync_enabled ? "Yes" : "No"}
            </Text>
            {syncStatus.last_sync_time && (
              <Text>
                <strong>Last Sync:</strong> {new Date(syncStatus.last_sync_time).toLocaleString()}
              </Text>
            )}
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>
    </Box>
  );
}

function LinkedSectionsTab() {
  const { course_id } = useParams();
  const [classWithSyncStatus, setClassWithSyncStatus] = useState<ClassWithSyncStatus>();
  const [isAccordionOpen, setIsAccordionOpen] = useState(false);
  useEffect(() => {
    const supabase = createClient();
    const fetchSections = async () => {
      try {
        const { data, error } = await supabase
          .from("classes")
          .select("*, class_sections(*), lab_sections(*), sis_sync_status(*)")
          .eq("id", parseInt(course_id as string))
          .single();

        if (error) {
          // Handle Supabase error
          const errorDescription = error.message + (error.details ? ` (${error.details})` : "");
          toaster.create({
            title: "Error fetching section sync status",
            description: errorDescription,
            type: "error"
          });
          return;
        }

        if (data) {
          setClassWithSyncStatus(data);
        } else {
          // No error but no data
          toaster.create({
            title: "Error fetching section sync status",
            description: "No class data found",
            type: "error"
          });
        }
      } catch (exception) {
        // Handle any thrown exceptions
        const errorMessage = exception instanceof Error ? exception.message : String(exception);
        toaster.create({
          title: "Error fetching section sync status",
          description: `Unexpected error: ${errorMessage}`,
          type: "error"
        });
      }
    };
    fetchSections();
  }, [course_id]);

  const syncStatusForClassSection = useCallback(
    (section: { id: number }) => {
      return classWithSyncStatus?.sis_sync_status?.find((status) => status.course_section_id === section.id);
    },
    [classWithSyncStatus]
  );

  const syncStatusForLabSection = useCallback(
    (section: { id: number }) => {
      return classWithSyncStatus?.sis_sync_status?.find((status) => status.lab_section_id === section.id);
    },
    [classWithSyncStatus]
  );

  // Calculate overall sync summary
  const getSyncSummary = useCallback((): {
    status: string;
    message: string;
    totalSections: number;
    healthySections: number;
    lastSyncMessage: string | null;
  } => {
    if (!classWithSyncStatus)
      return { status: "loading", message: "Loading...", totalSections: 0, healthySections: 0, lastSyncMessage: null };

    const allSections = [
      ...(classWithSyncStatus.class_sections || []),
      ...(classWithSyncStatus.lab_sections || [])
    ].filter((section) => section.sis_crn); // Only count sections with SIS CRN

    const totalSections = allSections.length;

    if (totalSections === 0) {
      return {
        status: "none",
        message: "No SIS-linked sections",
        totalSections: 0,
        healthySections: 0,
        lastSyncMessage: null
      };
    }

    let healthySections = 0;
    let enabledSections = 0;
    let errorSections = 0;
    let lastSyncMessage: string | null = null;

    // Process class sections
    (classWithSyncStatus.class_sections || []).forEach((section) => {
      if (!section.sis_crn) return; // Skip sections without SIS CRN

      const syncStatus = syncStatusForClassSection(section);

      if (syncStatus) {
        // Capture the sync message (they should all be the same, so just take the first one we find)
        if (!lastSyncMessage && syncStatus.last_sync_message) {
          lastSyncMessage = syncStatus.last_sync_message;
        }

        if (syncStatus.sync_enabled) {
          enabledSections++;

          // Check if healthy (enabled, successful, within 90 minutes)
          if (syncStatus.last_sync_time && syncStatus.last_sync_status === "success") {
            const lastSyncTime = new Date(syncStatus.last_sync_time);
            const now = new Date();
            const minutesAgo = (now.getTime() - lastSyncTime.getTime()) / (1000 * 60);

            if (minutesAgo <= 90) {
              healthySections++;
            }
          }

          if (syncStatus.last_sync_status === "error" || syncStatus.last_sync_status === "failed") {
            errorSections++;
          }
        }
      } else {
        // Section has SIS CRN but no sync status record - treat as enabled but not synced yet
        enabledSections++;
      }
    });

    // Process lab sections
    (classWithSyncStatus.lab_sections || []).forEach((section) => {
      if (!section.sis_crn) return; // Skip sections without SIS CRN

      const syncStatus = syncStatusForLabSection(section);

      if (syncStatus) {
        // Capture the sync message (they should all be the same, so just take the first one we find)
        if (!lastSyncMessage && syncStatus.last_sync_message) {
          lastSyncMessage = syncStatus.last_sync_message;
        }

        if (syncStatus.sync_enabled) {
          enabledSections++;

          // Check if healthy (enabled, successful, within 90 minutes)
          if (syncStatus.last_sync_time && syncStatus.last_sync_status === "success") {
            const lastSyncTime = new Date(syncStatus.last_sync_time);
            const now = new Date();
            const minutesAgo = (now.getTime() - lastSyncTime.getTime()) / (1000 * 60);

            if (minutesAgo <= 90) {
              healthySections++;
            }
          }

          if (syncStatus.last_sync_status === "error" || syncStatus.last_sync_status === "failed") {
            errorSections++;
          }
        }
      } else {
        // Section has SIS CRN but no sync status record - treat as enabled but not synced yet
        enabledSections++;
      }
    });

    if (healthySections === totalSections) {
      return {
        status: "healthy",
        message: `All ${totalSections} linked sections synced`,
        totalSections,
        healthySections,
        lastSyncMessage
      };
    } else if (errorSections > 0) {
      return {
        status: "error",
        message: `${errorSections} linked section${errorSections > 1 ? "s" : ""} with errors`,
        totalSections,
        healthySections,
        lastSyncMessage
      };
    } else if (enabledSections === 0) {
      return {
        status: "disabled",
        message: "Sync disabled for all linked sections",
        totalSections,
        healthySections,
        lastSyncMessage
      };
    } else {
      return {
        status: "partial",
        message: `${healthySections}/${totalSections} linked sections healthy`,
        totalSections,
        healthySections,
        lastSyncMessage
      };
    }
  }, [classWithSyncStatus, syncStatusForClassSection, syncStatusForLabSection]);

  const syncSummary = getSyncSummary();

  const getSummaryBadge = () => {
    switch (syncSummary.status) {
      case "healthy":
        return (
          <Badge colorPalette="green" size="sm">
            All Synced
          </Badge>
        );
      case "error":
        return (
          <Badge colorPalette="red" size="sm">
            Errors
          </Badge>
        );
      case "disabled":
        return (
          <Badge variant="subtle" size="sm">
            Disabled
          </Badge>
        );
      case "partial":
        return (
          <Badge colorPalette="yellow" size="sm">
            Partial
          </Badge>
        );
      case "none":
        return (
          <Badge variant="subtle" size="sm">
            No SIS Links
          </Badge>
        );
      default:
        return (
          <Badge variant="subtle" size="sm">
            Loading...
          </Badge>
        );
    }
  };

  const getSummaryIcon = () => {
    switch (syncSummary.status) {
      case "healthy":
        return (
          <Icon color="green.500">
            <CheckCircle size={16} />
          </Icon>
        );
      case "error":
        return (
          <Icon color="red.500">
            <XCircle size={16} />
          </Icon>
        );
      case "disabled":
      case "none":
        return (
          <Icon color="fg.muted">
            <XCircle size={16} />
          </Icon>
        );
      case "partial":
        return (
          <Icon color="yellow.500">
            <AlertCircle size={16} />
          </Icon>
        );
      default:
        return (
          <Icon color="fg.muted">
            <AlertCircle size={16} />
          </Icon>
        );
    }
  };
  return (
    <Accordion.Root
      collapsible
      value={isAccordionOpen ? ["sis-sync"] : []}
      onValueChange={(details) => setIsAccordionOpen(details.value.includes("sis-sync"))}
    >
      <Accordion.Item value="sis-sync">
        <Accordion.ItemTrigger
          _hover={{
            bg: "bg.muted",
            "& .expand-hint": {
              fontWeight: "bold"
            }
          }}
          transition="background-color 0.2s"
          borderRadius="md"
          p={3}
          mx={-3}
        >
          <Flex align="center" gap={3} width="100%">
            {getSummaryIcon()}
            <Box flex="1" textAlign="left">
              <Text fontWeight="medium">University Student Information System (SIS) Links</Text>
              <Text fontSize="sm" color="fg.muted">
                {syncSummary.message}
              </Text>
              {syncSummary.lastSyncMessage && (
                <Text fontSize="xs" color="fg.subtle" mt={1}>
                  Last sync result: {syncSummary.lastSyncMessage}
                </Text>
              )}
            </Box>
            <Flex align="center" gap={2}>
              {getSummaryBadge()}
              <Flex align="center" gap={1} color="fg.subtle" fontSize="xs" className="expand-hint">
                <Icon>{isAccordionOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</Icon>
                <Text>{isAccordionOpen ? "Click to collapse" : "Click to expand"}</Text>
              </Flex>
            </Flex>
          </Flex>
        </Accordion.ItemTrigger>
        <Accordion.ItemContent>
          <Box pt={4}>
            <Text fontSize="sm" color="fg.muted" mb={4}>
              Enrollments in this course are linked to the following SIS sections, and are automatically updated 15
              minutes past the hour:
            </Text>

            <Heading size="sm" mb={3}>
              Linked Class Sections
            </Heading>
            <List.Root as="ul" pl="4" mb={3}>
              {classWithSyncStatus?.class_sections?.map((section) => {
                const syncStatus = syncStatusForClassSection(section);
                return (
                  <List.Item key={section.id} as="li" fontSize="sm">
                    <Flex align="center" justify="space-between">
                      <Box>
                        <Text fontWeight="medium">
                          {section.name} - CRN: {section.sis_crn}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          {section.meeting_times}, {section.meeting_location}
                        </Text>
                      </Box>
                      {syncStatus ? (
                        <SyncStatusIndicator syncStatus={syncStatus} />
                      ) : (
                        <Badge variant="subtle" size="sm">
                          No sync configured
                        </Badge>
                      )}
                    </Flex>
                  </List.Item>
                );
              })}
            </List.Root>

            <Heading size="sm" mb={3}>
              Linked Lab Sections
            </Heading>
            <List.Root as="ul" pl="4" mb={3}>
              {classWithSyncStatus?.lab_sections?.map((section) => {
                const syncStatus = syncStatusForLabSection(section);
                return (
                  <List.Item key={section.id} as="li" fontSize="sm">
                    <Flex align="center" justify="space-between">
                      <Box>
                        <Text fontWeight="medium">
                          {section.name} - CRN: {section.sis_crn}
                        </Text>
                        {(section.meeting_times || section.meeting_location) && (
                          <Text fontSize="xs" color="fg.muted">
                            {[section.meeting_times, section.meeting_location].filter(Boolean).join(", ")}
                          </Text>
                        )}
                      </Box>
                      {syncStatus ? (
                        <SyncStatusIndicator syncStatus={syncStatus} />
                      ) : (
                        <Badge variant="subtle" size="sm">
                          No sync configured
                        </Badge>
                      )}
                    </Flex>
                  </List.Item>
                );
              })}
            </List.Root>
          </Box>
        </Accordion.ItemContent>
      </Accordion.Item>
    </Accordion.Root>
  );
}
export default function EnrollmentsPage() {
  return (
    <Container>
      <Heading my="4">Enrollments</Heading>
      <LinkedSectionsTab />
      <Box p="2" borderTop="1px solid" borderColor="border.muted" width="100%" mt={4}>
        <HStack justifyContent="flex-end">
          {" "}
          <ImportStudentsCSVModal />
          <AddSingleCourseMember />
        </HStack>
      </Box>
      <EnrollmentsTable />
    </Container>
  );
}
