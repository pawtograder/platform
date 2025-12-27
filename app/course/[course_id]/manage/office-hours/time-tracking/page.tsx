"use client";

import { Box, Card, HStack, Icon, Stack, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import React, { useMemo, useState } from "react";
import { BsExclamationTriangle } from "react-icons/bs";
import { useHelpRequestWorkSessions, useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";
import { useAllProfilesForClass } from "@/hooks/useCourseController";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";
import { useColorModeValue } from "@/components/ui/color-mode";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import PersonAvatar from "@/components/ui/person-avatar";
import { formatDuration } from "@/utils/time-formatting";
import WorkSessionsTable from "./work-sessions-table";

type WorkSessionWithDetails = {
  id: number;
  help_request_id: number;
  class_id: number;
  ta_profile_id: string;
  started_at: string;
  ended_at: string | null;
  queue_depth_at_start: number | null;
  longest_wait_seconds_at_start: number | null;
  notes: string | null;
  taName: string;
  studentName: string;
  durationSeconds: number;
  helpRequestTitle?: string;
};

export default function TimeTrackingPage() {
  const { course_id } = useParams();
  const courseId = Number(course_id);
  const allSessions = useHelpRequestWorkSessions();
  const profiles = useAllProfilesForClass();
  const helpRequestStudents = useHelpRequestStudents();
  const [dateFilter, setDateFilter] = useState<{ start?: string; end?: string }>({});

  // Create a map of help_request_id to student name(s)
  const helpRequestStudentMap = useMemo(() => {
    const map = new Map<number, string>();
    helpRequestStudents.forEach((hrs) => {
      const profile = profiles.find((p) => p.id === hrs.profile_id);
      if (profile && profile.name) {
        const existing = map.get(hrs.help_request_id);
        if (existing) {
          map.set(hrs.help_request_id, `${existing}, ${profile.name}`);
        } else {
          map.set(hrs.help_request_id, profile.name);
        }
      }
    });
    return map;
  }, [helpRequestStudents, profiles]);

  // Process sessions with TA names and durations
  const sessionsWithDetails: WorkSessionWithDetails[] = useMemo(() => {
    if (!allSessions) return [];

    return allSessions
      .filter((session) => {
        // Apply date filter if set
        if (dateFilter.start) {
          const sessionDate = new Date(session.started_at).toISOString().split("T")[0];
          if (sessionDate < dateFilter.start) return false;
        }
        if (dateFilter.end) {
          const sessionDate = new Date(session.started_at).toISOString().split("T")[0];
          if (sessionDate > dateFilter.end) return false;
        }
        return true;
      })
      .map((session) => {
        const startTime = new Date(session.started_at).getTime();
        const endTime = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
        const durationSeconds = Math.floor((endTime - startTime) / 1000);

        const taProfile = profiles.find((p) => p.id === session.ta_profile_id);
        const studentName = helpRequestStudentMap.get(session.help_request_id) || "Unknown Student";

        return {
          ...session,
          durationSeconds,
          taName: taProfile?.name || "Unknown TA",
          studentName
        };
      });
  }, [allSessions, profiles, dateFilter, helpRequestStudentMap]);

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const todaySessions = sessionsWithDetails.filter((s) => new Date(s.started_at) >= todayStart);
    const weekSessions = sessionsWithDetails.filter((s) => new Date(s.started_at) >= weekStart);

    const todayTotal = todaySessions.reduce((sum, s) => sum + s.durationSeconds, 0);
    const weekTotal = weekSessions.reduce((sum, s) => sum + s.durationSeconds, 0);
    const allTotal = sessionsWithDetails.reduce((sum, s) => sum + s.durationSeconds, 0);
    const avgDurationRaw = sessionsWithDetails.length > 0 ? allTotal / sessionsWithDetails.length : 0;
    const avgDuration = Math.round(avgDurationRaw / 60) * 60; // Round to nearest minute

    return {
      todayTotal,
      weekTotal,
      avgDuration,
      totalSessions: sessionsWithDetails.length
    };
  }, [sessionsWithDetails]);

  // Group sessions by day for chart
  const dailyData = useMemo(() => {
    const grouped = new Map<string, number>();

    sessionsWithDetails.forEach((session) => {
      const date = new Date(session.started_at).toISOString().split("T")[0];
      const existing = grouped.get(date) || 0;
      grouped.set(date, existing + session.durationSeconds);
    });

    return Array.from(grouped.entries())
      .map(([date, totalSeconds]) => ({
        date,
        totalMinutes: Math.floor(totalSeconds / 60),
        totalHours: Math.floor((totalSeconds / 3600) * 10) / 10
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [sessionsWithDetails]);

  // Group by TA for performance summary
  const taStats = useMemo(() => {
    const grouped = new Map<string, { totalSeconds: number; sessions: number; avgSeconds: number }>();

    sessionsWithDetails.forEach((session) => {
      const existing = grouped.get(session.ta_profile_id) || { totalSeconds: 0, sessions: 0, avgSeconds: 0 };
      existing.totalSeconds += session.durationSeconds;
      existing.sessions += 1;
      grouped.set(session.ta_profile_id, existing);
    });

    const overallAvg = summaryStats.avgDuration;

    return Array.from(grouped.entries())
      .map(([taId, stats]) => {
        const taProfile = profiles.find((p) => p.id === taId);
        const avgSecondsRaw = stats.totalSeconds / stats.sessions;
        const avgSeconds = Math.round(avgSecondsRaw / 60) * 60; // Round to nearest minute
        const vsAverageRaw = avgSecondsRaw - overallAvg;
        const vsAverage = Math.round(vsAverageRaw / 60) * 60; // Round to nearest minute
        return {
          taId,
          taName: taProfile?.name || "Unknown TA",
          totalSeconds: stats.totalSeconds,
          sessions: stats.sessions,
          avgSeconds,
          vsAverage
        };
      })
      .sort((a, b) => b.totalSeconds - a.totalSeconds);
  }, [sessionsWithDetails, profiles, summaryStats.avgDuration]);

  // Use processed sessions as table data
  const tableData = sessionsWithDetails;

  const tickColor = useColorModeValue("#000000", "#FFFFFF");
  const tooltipBg = useColorModeValue("#FFFFFF", "#1A1A1A");

  return (
    <VStack align="stretch" gap={6} p={4}>
      <Box>
        <Text fontSize="2xl" fontWeight="bold" mb={2}>
          TA Time Tracking
        </Text>
        <Text color="fg.muted">Track and analyze TA working patterns and time spent on help requests</Text>
      </Box>

      {/* Summary Cards */}
      <HStack gap={4} flexWrap="wrap">
        <Card.Root flex="1" minW="200px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Total Time Today
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {formatDuration(summaryStats.todayTotal)}
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root flex="1" minW="200px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Total Time This Week
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {formatDuration(summaryStats.weekTotal)}
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root flex="1" minW="200px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Average Session Duration
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {formatDuration(summaryStats.avgDuration)}
            </Text>
          </Card.Body>
        </Card.Root>

        <Card.Root flex="1" minW="200px">
          <Card.Body>
            <Text fontSize="sm" color="fg.muted" mb={1}>
              Total Sessions
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {summaryStats.totalSessions}
            </Text>
          </Card.Body>
        </Card.Root>
      </HStack>

      {/* Date Filter */}
      <HStack gap={2}>
        <Text fontSize="sm" fontWeight="medium">
          Filter by date:
        </Text>
        <Input
          type="date"
          value={dateFilter.start || ""}
          onChange={(e) => setDateFilter({ ...dateFilter, start: e.target.value })}
          size="sm"
          style={{ width: "150px" }}
        />
        <Text fontSize="sm">to</Text>
        <Input
          type="date"
          value={dateFilter.end || ""}
          onChange={(e) => setDateFilter({ ...dateFilter, end: e.target.value })}
          size="sm"
          style={{ width: "150px" }}
        />
        {(dateFilter.start || dateFilter.end) && (
          <Button size="sm" variant="ghost" onClick={() => setDateFilter({})}>
            Clear
          </Button>
        )}
      </HStack>

      {/* Daily Time Chart */}
      {dailyData.length > 0 && (
        <Card.Root>
          <Card.Header>
            <Text fontSize="lg" fontWeight="semibold">
              Time Worked by Day
            </Text>
          </Card.Header>
          <Card.Body>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: tickColor, fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  height={80}
                />
                <YAxis tick={{ fill: tickColor }} label={{ value: "Hours", angle: -90, position: "insideLeft" }} />
                <Tooltip
                  contentStyle={{ backgroundColor: tooltipBg }}
                  formatter={(value: number) => [`${value.toFixed(1)}h`, "Time"]}
                />
                <Bar dataKey="totalHours" fill="#3B82F6" />
              </BarChart>
            </ResponsiveContainer>
          </Card.Body>
        </Card.Root>
      )}

      {/* TA Performance Summary */}
      {taStats.length > 0 && (
        <Card.Root>
          <Card.Header>
            <Text fontSize="lg" fontWeight="semibold">
              TA Performance Summary
            </Text>
          </Card.Header>
          <Card.Body>
            <Stack spaceY={3}>
              {taStats.map((ta) => {
                const isAboveAverage = ta.vsAverage > 0;
                const isBelowAverage = ta.vsAverage < 0;

                return (
                  <Box key={ta.taId} p={3} borderWidth="1px" borderRadius="md" bg="bg.subtle">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={1}>
                        <HStack gap={2}>
                          <PersonAvatar uid={ta.taId} size="sm" />
                          <Text fontWeight="semibold">{ta.taName}</Text>
                        </HStack>
                        <HStack gap={4} fontSize="sm" color="fg.muted">
                          <Text>Total: {formatDuration(ta.totalSeconds)}</Text>
                          <Text>Sessions: {ta.sessions}</Text>
                          <Text>Avg: {formatDuration(ta.avgSeconds)}</Text>
                          {isAboveAverage && (
                            <HStack gap={1} color="orange.500">
                              <Icon as={BsExclamationTriangle} />
                              <Text>{formatDuration(Math.abs(ta.vsAverage))} above average</Text>
                            </HStack>
                          )}
                          {isBelowAverage && (
                            <HStack gap={1} color="green.500">
                              <Text>{formatDuration(Math.abs(ta.vsAverage))} below average</Text>
                            </HStack>
                          )}
                        </HStack>
                      </VStack>
                    </HStack>
                  </Box>
                );
              })}
            </Stack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Queue Context Warnings */}
      {sessionsWithDetails.some(
        (s) => s.queue_depth_at_start && s.queue_depth_at_start > 2 && s.durationSeconds > 1200
      ) && (
        <Card.Root borderColor="orange.500">
          <Card.Header>
            <HStack gap={2}>
              <Icon as={BsExclamationTriangle} color="orange.500" />
              <Text fontSize="lg" fontWeight="semibold" color="orange.500">
                Queue Context Warnings
              </Text>
            </HStack>
          </Card.Header>
          <Card.Body>
            <Stack spaceY={2}>
              {sessionsWithDetails
                .filter((s) => s.queue_depth_at_start && s.queue_depth_at_start > 2 && s.durationSeconds > 1200)
                .map((session) => (
                  <Box
                    key={session.id}
                    p={2}
                    bg="bg.warning"
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor="border.warning"
                  >
                    <Text fontSize="sm">
                      <Text as="span" fontWeight="semibold">
                        {session.taName}
                      </Text>
                      {" spent "}
                      <Text as="span" fontWeight="semibold">
                        {formatDuration(session.durationSeconds)}
                      </Text>
                      {" helping one student while "}
                      <Text as="span" fontWeight="semibold">
                        {session.queue_depth_at_start} other students
                      </Text>
                      {" were waiting"}
                      {session.longest_wait_seconds_at_start && (
                        <>
                          {" (longest wait: "}
                          <Text as="span" fontWeight="semibold">
                            {formatDuration(session.longest_wait_seconds_at_start)}
                          </Text>
                          {")"}
                        </>
                      )}
                    </Text>
                  </Box>
                ))}
            </Stack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Data Table */}
      <Card.Root>
        <Card.Header>
          <Text fontSize="lg" fontWeight="semibold">
            All Work Sessions
          </Text>
        </Card.Header>
        <Card.Body>
          <WorkSessionsTable sessions={tableData} courseId={courseId} />
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
