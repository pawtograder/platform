"use client";

import type { Alert, GroupAnalytics } from "@/types/survey-analytics";
import { Badge, Box, HStack, SimpleGrid, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";

type GroupSummaryCardsProps = {
  groupAnalytics: GroupAnalytics[];
  selectedGroupId: number | null;
  onSelectGroup: (groupId: number) => void;
  obfuscateStats?: boolean;
};

function AlertIndicators({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const warning = alerts.filter((a) => a.severity === "warning").length;
  const info = alerts.filter((a) => a.severity === "info").length;
  return (
    <HStack gap={1} flexWrap="wrap">
      {critical > 0 && (
        <Badge colorPalette="red" size="sm" title={`${critical} critical issue${critical > 1 ? "s" : ""}`}>
          {critical} critical
        </Badge>
      )}
      {warning > 0 && (
        <Badge colorPalette="orange" size="sm" title={`${warning} warning${warning > 1 ? "s" : ""}`}>
          {warning} warn
        </Badge>
      )}
      {info > 0 && (
        <Badge colorPalette="blue" size="sm" variant="subtle" title={`${info} info`}>
          {info}
        </Badge>
      )}
    </HStack>
  );
}

export function GroupSummaryCards({
  groupAnalytics,
  selectedGroupId,
  onSelectGroup,
  obfuscateStats = false
}: GroupSummaryCardsProps) {
  const sortedGroups = useMemo(
    () =>
      [...groupAnalytics].sort((a, b) => a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" })),
    [groupAnalytics]
  );

  return (
    <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap={3} w="100%">
      {sortedGroups.map((group) => {
        const stats = Object.values(group.questionStats)[0];
        const isSelected = selectedGroupId === group.groupId;
        const hasCritical = group.alerts.some((a) => a.severity === "critical");
        const hasWarning = group.alerts.some((a) => a.severity === "warning");
        return (
          <Box
            key={group.groupId}
            as="button"
            textAlign="left"
            p={4}
            borderRadius="md"
            borderWidth="2px"
            borderColor={isSelected ? "blue.500" : "border"}
            borderLeftWidth={hasCritical || hasWarning ? 4 : undefined}
            borderLeftColor={hasCritical ? "red.500" : hasWarning ? "orange.500" : undefined}
            bg={isSelected ? "blue.50" : "bg.subtle"}
            _dark={{ bg: isSelected ? "blue.900" : undefined }}
            _hover={{ borderColor: "blue.400", bg: isSelected ? "blue.50" : "bg.muted" }}
            cursor="pointer"
            w="100%"
            h="full"
            alignSelf="stretch"
            onClick={() => onSelectGroup(group.groupId)}
          >
            <VStack align="stretch" gap={1}>
              <Text fontWeight="semibold" fontSize="sm">
                {group.groupName}
              </Text>
              {group.alerts.length > 0 && <AlertIndicators alerts={group.alerts} />}
              {group.mentorName && (
                <Text fontSize="xs" color="fg.muted">
                  Mentor: {group.mentorName}
                </Text>
              )}
              <Badge colorPalette="blue" size="sm" w="fit-content">
                {group.responseCount}/{group.memberCount} responses
              </Badge>
              {!obfuscateStats && stats && (
                <Text fontSize="xs" color="fg.muted">
                  Mean: {stats.mean.toFixed(2)} · σ {stats.stdDev.toFixed(2)}
                </Text>
              )}
            </VStack>
          </Box>
        );
      })}
    </SimpleGrid>
  );
}
