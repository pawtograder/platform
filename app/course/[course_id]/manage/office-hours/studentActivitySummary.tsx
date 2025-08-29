"use client";

import { Box, HStack, VStack, Text, Icon, Badge, Separator } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Select } from "chakra-react-select";
import { BsStar, BsStarFill, BsPerson, BsClock, BsShield, BsExclamationTriangle } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { useStudentKarmaNotes, useStudentHelpActivity, useHelpRequestModeration } from "@/hooks/useOfficeHoursRealtime";
import { useStudentRoster } from "@/hooks/useCourseController";

type StudentActivitySummaryProps = {
  studentProfileId?: string;
  classId?: number;
  compact?: boolean;
};

/**
 * Component that displays a summary of a student's recent activity and karma.
 * Helps TAs understand a student's background when providing assistance.
 * Uses realtime data from the office hours system.
 */
export default function StudentActivitySummary({
  studentProfileId,
  classId,
  compact = false
}: StudentActivitySummaryProps) {
  const params = useParams();
  const courseId = classId || parseInt(params["course_id"] as string, 10);
  const [selectedStudentId, setSelectedStudentId] = useState<string>("");

  // Get all realtime data for the class
  const allKarmaNotes = useStudentKarmaNotes();
  const allHelpActivity = useStudentHelpActivity();
  const allModerationActions = useHelpRequestModeration();
  const studentRoster = useStudentRoster();

  // Prepare options for react-select
  const studentOptions = useMemo(
    () =>
      studentRoster?.map((student) => ({
        value: student.id,
        label: student.name || student.sortable_name || "Unknown Student"
      })),
    [studentRoster]
  );

  // Filter data for the specific student or show aggregate data
  const currentStudentId = studentProfileId || selectedStudentId;
  const karmaEntry = useMemo(() => {
    if (!currentStudentId) return undefined;
    return allKarmaNotes.find((karma) => karma.student_profile_id === currentStudentId && karma.class_id === courseId);
  }, [allKarmaNotes, currentStudentId, courseId]);

  const recentActivity = useMemo(() => {
    const studentIds = studentRoster?.map((student) => student.id) || [];
    const filtered = currentStudentId
      ? allHelpActivity.filter(
          (activity) => activity.student_profile_id === currentStudentId && activity.class_id === courseId
        )
      : allHelpActivity.filter(
          (activity) => activity.class_id === courseId && studentIds.includes(activity.student_profile_id)
        );

    return filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 10);
  }, [allHelpActivity, currentStudentId, courseId, studentRoster]);

  const recentModeration = useMemo(() => {
    const studentIds = studentRoster?.map((student) => student.id) || [];
    const filtered = currentStudentId
      ? allModerationActions.filter(
          (action) => action.student_profile_id === currentStudentId && action.class_id === courseId
        )
      : allModerationActions.filter(
          (action) => action.class_id === courseId && studentIds.includes(action.student_profile_id)
        );

    return filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 5);
  }, [allModerationActions, currentStudentId, courseId, studentRoster]);

  const getKarmaColor = (score: number) => {
    if (score >= 10) return "green";
    if (score >= 5) return "blue";
    if (score >= 0) return "yellow";
    if (score >= -5) return "orange";
    return "red";
  };

  const getKarmaLabel = (score: number) => {
    if (score >= 10) return "Excellent";
    if (score >= 5) return "Good";
    if (score >= 0) return "Neutral";
    if (score >= -5) return "Needs Attention";
    return "Problematic";
  };

  const renderStars = (score: number, size: number = 3) => {
    const stars = [];
    const maxStars = 5;
    const normalizedScore = Math.min(Math.max(score, -10), 10);
    const filledStars = Math.ceil((normalizedScore + 10) / 4);

    for (let i = 0; i < maxStars; i++) {
      stars.push(
        <Icon key={i} as={i < filledStars ? BsStarFill : BsStar} color={getKarmaColor(score)} boxSize={size} />
      );
    }
    return stars;
  };

  const getActivityTypeIcon = (activityType: string) => {
    switch (activityType) {
      case "request_created":
        return BsPerson;
      case "message_sent":
        return BsClock;
      default:
        return BsPerson;
    }
  };

  const getActivityTypeLabel = (activityType: string) => {
    switch (activityType) {
      case "request_created":
        return "Created request";
      case "request_updated":
        return "Updated request";
      case "message_sent":
        return "Sent message";
      case "request_resolved":
        return "Request resolved";
      case "video_joined":
        return "Joined video";
      case "video_left":
        return "Left video";
      default:
        return activityType;
    }
  };

  const getModerationIcon = (actionType: string) => {
    switch (actionType) {
      case "warning":
        return BsExclamationTriangle;
      case "temporary_ban":
      case "permanent_ban":
        return BsShield;
      default:
        return BsShield;
    }
  };

  const getModerationColor = (actionType: string) => {
    switch (actionType) {
      case "warning":
        return "yellow";
      case "temporary_ban":
        return "orange";
      case "permanent_ban":
        return "red";
      default:
        return "gray";
    }
  };

  if (compact) {
    return (
      <Box p={3} borderRadius="md" borderWidth="1px">
        <VStack align="start" gap={2}>
          {karmaEntry && (
            <HStack>
              <Text fontSize="sm" fontWeight="medium">
                Karma:
              </Text>
              <HStack>
                {renderStars(karmaEntry.karma_score, 3)}
                <Text fontSize="sm">({karmaEntry.karma_score})</Text>
              </HStack>
            </HStack>
          )}

          {recentModeration.length > 0 && (
            <HStack>
              <Icon as={BsShield} color="red.500" boxSize={3} />
              <Text fontSize="sm" color="red.600">
                {recentModeration.length} recent moderation action{recentModeration.length > 1 ? "s" : ""}
              </Text>
            </HStack>
          )}
        </VStack>
      </Box>
    );
  }

  return (
    <Box p={4} borderRadius="md" borderWidth="1px">
      <VStack align="start" gap={4}>
        <HStack justify="space-between" width="100%">
          <Text fontWeight="semibold">
            {currentStudentId ? "Student Activity Summary" : "Recent Office Hours Activity"}
          </Text>
          {!studentProfileId && (
            <Box width="250px">
              <Select
                placeholder="Select a student"
                options={studentOptions}
                value={studentOptions?.find((option) => option.value === selectedStudentId) || null}
                onChange={(option) => setSelectedStudentId(option?.value || "")}
                isClearable
                size="sm"
              />
            </Box>
          )}
        </HStack>

        {/* Karma Section */}
        {karmaEntry && (
          <VStack align="start" gap={2}>
            <Text fontSize="sm" fontWeight="medium">
              Student Karma
            </Text>
            <HStack>
              {renderStars(karmaEntry.karma_score)}
              <Badge colorPalette={getKarmaColor(karmaEntry.karma_score)} size="sm">
                {karmaEntry.karma_score} - {getKarmaLabel(karmaEntry.karma_score)}
              </Badge>
            </HStack>
            {karmaEntry.internal_notes && (
              <Text fontSize="sm" fontStyle="italic">
                &ldquo;{karmaEntry.internal_notes}&rdquo;
              </Text>
            )}
            <Text fontSize="xs">
              Last updated {formatDistanceToNow(new Date(karmaEntry.updated_at), { addSuffix: true })}
            </Text>
          </VStack>
        )}

        {/* Moderation History */}
        {recentModeration.length > 0 && (
          <>
            <Separator />
            <VStack align="start" gap={2}>
              <Text fontSize="sm" fontWeight="medium" color="red.600">
                Recent Moderation Actions
              </Text>
              {recentModeration.map((action) => (
                <HStack key={action.id} fontSize="sm">
                  <Icon
                    as={getModerationIcon(action.action_type)}
                    color={`${getModerationColor(action.action_type)}.500`}
                  />
                  <Text>{action.action_type.replace("_", " ")}</Text>
                  <Text>{formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}</Text>
                </HStack>
              ))}
            </VStack>
          </>
        )}

        {/* Recent Activity */}
        {recentActivity.length > 0 && (
          <>
            <Separator />
            <VStack align="start" gap={2}>
              <Text fontSize="sm" fontWeight="medium">
                Recent Activity
              </Text>
              {recentActivity.map((activity) => (
                <HStack key={activity.id} fontSize="sm">
                  <Icon as={getActivityTypeIcon(activity.activity_type)} color="blue.500" />
                  <Text>{getActivityTypeLabel(activity.activity_type)}</Text>
                  <Text>{formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}</Text>
                </HStack>
              ))}
            </VStack>
          </>
        )}

        {!karmaEntry && recentActivity.length === 0 && recentModeration.length === 0 && (
          <Text fontSize="sm">
            {currentStudentId
              ? "No activity data available for this student."
              : "No recent office hours activity. Select a student to view individual activity."}
          </Text>
        )}
      </VStack>
    </Box>
  );
}
