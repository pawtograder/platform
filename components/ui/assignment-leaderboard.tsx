"use client";
import PersonName from "@/components/ui/person-name";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { AssignmentLeaderboardEntry } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Heading, HStack, Skeleton, Table, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useMemo } from "react";

interface AssignmentLeaderboardProps {
  assignmentId: number;
  maxEntries?: number;
}

export default function AssignmentLeaderboard({ assignmentId, maxEntries = 10 }: AssignmentLeaderboardProps) {
  const { private_profile_id } = useClassProfiles();

  const { data: leaderboardData, isLoading } = useList<AssignmentLeaderboardEntry>({
    resource: "assignment_leaderboard",
    filters: [{ field: "assignment_id", operator: "eq", value: assignmentId }],
    sorters: [{ field: "autograder_score", order: "desc" }],
    pagination: { pageSize: maxEntries }
  });

  const leaderboardEntries = useMemo(() => {
    return leaderboardData?.data || [];
  }, [leaderboardData]);

  // Find if the current user is in the leaderboard
  const currentUserEntry = useMemo(() => {
    return leaderboardEntries.find((entry) => entry.private_profile_id === private_profile_id);
  }, [leaderboardEntries, private_profile_id]);

  const currentUserRank = useMemo(() => {
    if (!currentUserEntry) return null;
    return leaderboardEntries.findIndex((entry) => entry.private_profile_id === private_profile_id) + 1;
  }, [leaderboardEntries, currentUserEntry, private_profile_id]);

  if (isLoading) {
    return (
      <Box borderWidth={1} borderRadius="md" p={4} bg="bg.subtle">
        <Skeleton height="200px" />
      </Box>
    );
  }

  if (leaderboardEntries.length === 0) {
    return null;
  }

  return (
    <Box borderWidth={1} borderRadius="md" p={4} bg="bg.subtle" maxW="lg">
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Heading size="sm">🏆 Leaderboard</Heading>
          <Text fontSize="xs" color="fg.muted">
            Top {Math.min(maxEntries, leaderboardEntries.length)} by autograder score
          </Text>
        </HStack>

        <Table.Root size="sm" variant="outline">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader width="60px">Rank</Table.ColumnHeader>
              <Table.ColumnHeader>Student</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right" width="100px">
                Score
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {leaderboardEntries.map((entry, index) => {
              const rank = index + 1;
              const isCurrentUser = entry.private_profile_id === private_profile_id;

              return (
                <Table.Row
                  key={entry.id}
                  bg={isCurrentUser ? "bg.info" : undefined}
                  fontWeight={isCurrentUser ? "semibold" : "normal"}
                >
                  <Table.Cell>
                    <HStack gap={1}>
                      {rank === 1 && <Text>🥇</Text>}
                      {rank === 2 && <Text>🥈</Text>}
                      {rank === 3 && <Text>🥉</Text>}
                      {rank > 3 && <Text color="fg.muted">{rank}</Text>}
                    </HStack>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack>
                      <PersonName uid={entry.public_profile_id} size="xs" showAvatar={true} />
                      {isCurrentUser && (
                        <Badge colorPalette="blue" size="sm">
                          You
                        </Badge>
                      )}
                    </HStack>
                  </Table.Cell>
                  <Table.Cell textAlign="right">
                    <Text>
                      {entry.autograder_score}/{entry.max_score}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>

        {currentUserEntry && currentUserRank && currentUserRank > maxEntries && (
          <Box borderTopWidth={1} borderStyle="dashed" pt={2} mt={1}>
            <Text fontSize="sm" color="fg.muted" mb={2}>
              Your ranking:
            </Text>
            <HStack justify="space-between" px={2}>
              <HStack gap={2}>
                <Text fontWeight="semibold">#{currentUserRank}</Text>
                <PersonName uid={currentUserEntry.public_profile_id} size="xs" showAvatar={true} />
              </HStack>
              <Text>
                {currentUserEntry.autograder_score}/{currentUserEntry.max_score}
              </Text>
            </HStack>
          </Box>
        )}
      </VStack>
    </Box>
  );
}
