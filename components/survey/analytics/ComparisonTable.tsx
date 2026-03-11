"use client";

import type { GroupAnalytics, SurveyAnalyticsConfig } from "@/types/survey-analytics";
import { Badge, Box, Button, HStack, Table, Text, VStack } from "@chakra-ui/react";
import { Fragment, useState } from "react";
import { getHealthColor } from "./utils";

type ComparisonTableProps = {
  groupAnalytics: GroupAnalytics[];
  selectedQuestion: string | null;
  questionTitle: string;
  courseMean: number;
  analyticsConfig: SurveyAnalyticsConfig | null;
  onSelectGroup?: (groupId: number) => void;
  mentorFilter?: string | null;
};

export function ComparisonTable({
  groupAnalytics,
  selectedQuestion,
  questionTitle,
  courseMean,
  analyticsConfig,
  onSelectGroup,
  mentorFilter
}: ComparisonTableProps) {
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);

  const filteredGroups = mentorFilter ? groupAnalytics.filter((g) => g.mentorId === mentorFilter) : groupAnalytics;

  const sortedGroups = [...filteredGroups].sort((a, b) => {
    if (!selectedQuestion) return 0;
    const statsA = a.questionStats[selectedQuestion];
    const statsB = b.questionStats[selectedQuestion];
    if (!statsA || !statsB) return 0;
    return statsA.mean - statsB.mean;
  });

  if (!selectedQuestion) {
    return (
      <Box p={4}>
        <Text color="fg.muted">Select a question to view comparison</Text>
      </Box>
    );
  }

  return (
    <Box overflowX="auto">
      <Table.Root variant="outline" size="sm">
        <Table.Caption textAlign="left" mb={2}>
          {questionTitle}
        </Table.Caption>
        <Table.Header>
          <Table.Row bg="bg.subtle">
            <Table.ColumnHeader w="40px" />
            <Table.ColumnHeader>Group</Table.ColumnHeader>
            <Table.ColumnHeader>Mentor</Table.ColumnHeader>
            <Table.ColumnHeader>Responses</Table.ColumnHeader>
            <Table.ColumnHeader>Mean</Table.ColumnHeader>
            <Table.ColumnHeader>Δ vs Course</Table.ColumnHeader>
            <Table.ColumnHeader>Min</Table.ColumnHeader>
            <Table.ColumnHeader>Max</Table.ColumnHeader>
            <Table.ColumnHeader>σ</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {sortedGroups.map((group) => {
            const stats = group.questionStats[selectedQuestion];
            const delta = stats ? stats.mean - courseMean : 0;
            const stdDev = stats?.stdDev ?? 0;
            const health = getHealthColor(delta, stdDev, analyticsConfig ?? undefined);
            const isExpanded = expandedGroupId === group.groupId;

            return (
              <Fragment key={group.groupId}>
                <Table.Row
                  bg={health === "critical" ? "red.50" : health === "warning" ? "yellow.50" : undefined}
                  _dark={{
                    bg: health === "critical" ? "red.900" : health === "warning" ? "yellow.900" : undefined
                  }}
                  cursor={onSelectGroup ? "pointer" : undefined}
                  onClick={() => onSelectGroup?.(group.groupId)}
                >
                  <Table.Cell>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedGroupId(isExpanded ? null : group.groupId);
                      }}
                    >
                      {isExpanded ? "−" : "+"}
                    </Button>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontWeight="medium">{group.groupName}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontSize="sm" color="fg.muted">
                      {group.mentorName ?? "—"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge colorPalette="blue">
                      {group.responseCount}/{group.memberCount}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>{stats ? stats.mean.toFixed(2) : "—"}</Table.Cell>
                  <Table.Cell>
                    {stats && (
                      <Text color={delta > 0 ? "red.600" : delta < 0 ? "green.600" : "fg.muted"} fontSize="sm">
                        {delta > 0 ? "+" : ""}
                        {delta.toFixed(2)}
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>{stats?.min ?? "—"}</Table.Cell>
                  <Table.Cell>{stats?.max ?? "—"}</Table.Cell>
                  <Table.Cell>{stats ? stats.stdDev.toFixed(2) : "—"}</Table.Cell>
                </Table.Row>
                {isExpanded && (
                  <Table.Row>
                    <Table.Cell colSpan={9} bg="bg.subtle" py={4}>
                      <VStack align="stretch" gap={2} pl={8}>
                        <Text fontSize="sm" fontWeight="medium">
                          Response distribution
                        </Text>
                        {stats?.distribution && Object.keys(stats.distribution).length > 0 ? (
                          <HStack gap={4} flexWrap="wrap">
                            {Object.entries(stats.distribution)
                              .sort(([a], [b]) => Number(a) - Number(b))
                              .map(([value, count]) => (
                                <Badge key={value} colorPalette="gray">
                                  {value}: {count}
                                </Badge>
                              ))}
                          </HStack>
                        ) : (
                          <Text fontSize="sm" color="fg.muted">
                            No individual response data
                          </Text>
                        )}
                      </VStack>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Fragment>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
