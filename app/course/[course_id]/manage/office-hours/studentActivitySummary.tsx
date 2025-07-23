"use client";

import { Box, HStack, VStack, Text, Icon, Badge, Separator } from "@chakra-ui/react";
import { useMemo } from "react";
import { BsStar, BsStarFill, BsPerson, BsClock, BsShield, BsExclamationTriangle } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { useStudentKarmaNotes, useStudentHelpActivity, useHelpRequestModeration } from "@/hooks/useOfficeHoursRealtime";

type StudentActivitySummaryProps = {
  studentProfileId: string;
  classId: number;
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
  // Get all realtime data for the class
  const allKarmaNotes = useStudentKarmaNotes();
  const allHelpActivity = useStudentHelpActivity();
  const allModerationActions = useHelpRequestModeration();

  // Filter data for the specific student
  const karmaEntry = useMemo(() => {
    return allKarmaNotes.find((karma) => karma.student_profile_id === studentProfileId && karma.class_id === classId);
  }, [allKarmaNotes, studentProfileId, classId]);

  const recentActivity = useMemo(() => {
    return allHelpActivity
      .filter((activity) => activity.student_profile_id === studentProfileId && activity.class_id === classId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5);
  }, [allHelpActivity, studentProfileId, classId]);

  const recentModeration = useMemo(() => {
    return allModerationActions
      .filter((action) => action.student_profile_id === studentProfileId && action.class_id === classId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 3);
  }, [allModerationActions, studentProfileId, classId]);

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
        <Text fontWeight="semibold">Student Activity Summary</Text>

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
          <Text fontSize="sm">No activity data available for this student.</Text>
        )}
      </VStack>
    </Box>
  );
}
