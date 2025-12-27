"use client";

import PersonAvatar from "@/components/ui/person-avatar";
import { toaster } from "@/components/ui/toaster";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import { useOfficeHoursController, useWorkSessionsForRequest } from "@/hooks/useOfficeHoursRealtime";
import { Box, HStack, Icon, IconButton, Separator, Stack, Text } from "@chakra-ui/react";
import { useMemo } from "react";
import { BsClock, BsPencil, BsPeople, BsTrash } from "react-icons/bs";

interface WorkSessionHistoryProps {
  help_request_id: number;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "In progress";
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString();
}

export default function WorkSessionHistory({ help_request_id }: WorkSessionHistoryProps) {
  const sessions = useWorkSessionsForRequest(help_request_id);
  const profiles = useAllProfilesForClass();
  const isInstructor = useIsInstructor();
  const controller = useOfficeHoursController();

  // Sort sessions by start time (newest first)
  const sortedSessions = useMemo(() => {
    if (!sessions) return [];
    return [...sessions].sort((a, b) => 
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );
  }, [sessions]);

  // Calculate duration for each session
  const sessionsWithDuration = useMemo(() => {
    return sortedSessions.map((session) => {
      const startTime = new Date(session.started_at).getTime();
      const endTime = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
      const durationSeconds = Math.floor((endTime - startTime) / 1000);
      
      const taProfile = profiles.find((p) => p.id === session.ta_profile_id);
      
      return {
        ...session,
        durationSeconds,
        taName: taProfile?.name || "Unknown TA"
      };
    });
  }, [sortedSessions, profiles]);

  const handleDelete = async (sessionId: number) => {
    try {
      await controller.helpRequestWorkSessions.delete(sessionId);
      toaster.success({
        title: "Session deleted",
        description: "Work session has been deleted successfully"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to delete session: ${error instanceof Error ? error.message : "Unknown error"}`
      });
    }
  };

  if (!sessions || sessions.length === 0) {
    return (
      <Box p={4} borderWidth="1px" borderRadius="md" bg="bg.subtle">
        <Text fontSize="sm" color="fg.muted">
          No work sessions recorded yet
        </Text>
      </Box>
    );
  }

  return (
    <Stack spaceY={3}>
      <Text fontSize="lg" fontWeight="semibold">
        Work Session History ({sessionsWithDuration.length})
      </Text>
      
      {sessionsWithDuration.map((session, index) => {
        const isActive = !session.ended_at;
        
        return (
          <Box
            key={session.id}
            p={4}
            borderWidth="1px"
            borderRadius="md"
            bg={isActive ? "bg.emphasized" : "bg.subtle"}
            borderColor={isActive ? "border.emphasized" : "border.subtle"}
          >
            <HStack justify="space-between" align="start">
              <Stack spaceY={2} flex="1">
                <HStack gap={2}>
                  <PersonAvatar
                    uid={session.ta_profile_id}
                    size="sm"
                  />
                  <Text fontWeight="medium">{session.taName}</Text>
                  {isActive && (
                    <Box
                      as="span"
                      px={2}
                      py={0.5}
                      borderRadius="full"
                      bg="colorPalette.500"
                      color="white"
                      fontSize="xs"
                      fontWeight="semibold"
                    >
                      Active
                    </Box>
                  )}
                </HStack>
                
                <HStack gap={4} fontSize="sm" color="fg.muted">
                  <HStack gap={1}>
                    <Icon as={BsClock} />
                    <Text>
                      {formatDuration(session.durationSeconds)}
                      {isActive && " (so far)"}
                    </Text>
                  </HStack>
                  
                  <HStack gap={1}>
                    <Icon as={BsPeople} />
                    <Text>
                      Queue depth: {session.queue_depth_at_start ?? "N/A"}
                    </Text>
                  </HStack>
                  
                  {session.longest_wait_seconds_at_start !== null && (
                    <Text>
                      Longest wait: {formatDuration(session.longest_wait_seconds_at_start)}
                    </Text>
                  )}
                </HStack>
                
                <Text fontSize="xs" color="fg.muted">
                  Started: {formatDate(session.started_at)}
                  {session.ended_at && ` • Ended: ${formatDate(session.ended_at)}`}
                </Text>
                
                {session.notes && (
                  <Box mt={2} p={2} bg="bg.emphasized" borderRadius="md">
                    <Text fontSize="sm" fontStyle="italic">
                      {session.notes}
                    </Text>
                  </Box>
                )}
              </Stack>
              
              {isInstructor && (
                <HStack gap={1}>
                  <IconButton
                    aria-label="Edit session"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      // TODO: Implement edit modal
                      toaster.info({
                        title: "Edit session",
                        description: "Edit functionality coming soon"
                      });
                    }}
                  >
                    <Icon as={BsPencil} />
                  </IconButton>
                  <IconButton
                    aria-label="Delete session"
                    size="sm"
                    variant="ghost"
                    colorPalette="red"
                    onClick={() => handleDelete(session.id)}
                  >
                    <Icon as={BsTrash} />
                  </IconButton>
                </HStack>
              )}
            </HStack>
            
            {index < sessionsWithDuration.length - 1 && (
              <Separator mt={3} />
            )}
          </Box>
        );
      })}
      
      {sessionsWithDuration.length > 1 && (
        <Box p={3} bg="bg.emphasized" borderRadius="md" borderWidth="1px">
          <HStack justify="space-between">
            <Text fontWeight="semibold">Total Time:</Text>
            <Text fontWeight="bold" fontSize="lg">
              {formatDuration(
                sessionsWithDuration.reduce((sum, s) => {
                  const start = new Date(s.started_at).getTime();
                  const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
                  return sum + Math.floor((end - start) / 1000);
                }, 0)
              )}
            </Text>
          </HStack>
        </Box>
      )}
    </Stack>
  );
}

