"use client";

import { Box, Text, Icon, Badge, HStack, VStack, Input, Card, Heading, Separator, EmptyState } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useList } from "@refinedev/core";
import { useHelpRequestFeedback } from "@/hooks/useOfficeHoursRealtime";
import { formatDistanceToNow } from "date-fns";
import {
  BsHandThumbsUp,
  BsHandThumbsDown,
  BsSearch,
  BsFilter,
  BsPersonFill,
  BsChatText,
  BsCalendarEvent,
  BsExclamationCircle,
  BsBoxArrowUpRight
} from "react-icons/bs";
import { Select } from "chakra-react-select";
import { HelpRequestFeedback, HelpRequest, UserProfile } from "@/utils/supabase/DatabaseTypes";

type FeedbackWithDetails = HelpRequestFeedback & {
  help_request?: HelpRequest;
  student_profile?: UserProfile;
};

/**
 * Component for displaying help request feedback from students.
 * Allows instructors to view student satisfaction ratings and comments
 * to improve the office hours experience.
 */
export default function HelpRequestFeedbackComponent() {
  const params = useParams();
  const classId = parseInt(params.course_id as string, 10);

  const [searchTerm, setSearchTerm] = useState("");
  const [filterRating, setFilterRating] = useState<"all" | "positive" | "negative">("all");

  // Fetch help request feedback data using realtime hook
  const allFeedback = useHelpRequestFeedback();

  // Filter by class_id since the hook returns all feedback
  const feedbackData = useMemo(() => {
    return allFeedback
      .filter((feedback) => feedback.class_id === classId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [allFeedback, classId]);

  // Fetch help requests for context
  const { data: helpRequestsData } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 }
  });

  // Fetch student profiles
  const { data: profilesData } = useList<UserProfile>({
    resource: "profiles",
    pagination: { pageSize: 1000 }
  });

  // Process and combine data
  const feedbackWithDetails = useMemo<FeedbackWithDetails[]>(() => {
    if (!feedbackData) return [];

    const helpRequestsMap = new Map(helpRequestsData?.data?.map((req: HelpRequest) => [req.id, req]) || []);
    const profilesMap = new Map(profilesData?.data?.map((profile: UserProfile) => [profile.id, profile]) || []);

    return feedbackData.map(
      (feedback): FeedbackWithDetails => ({
        ...feedback,
        help_request: helpRequestsMap.get(feedback.help_request_id),
        student_profile: profilesMap.get(feedback.student_profile_id)
      })
    );
  }, [feedbackData, helpRequestsData?.data, profilesData?.data]);

  // Filter feedback based on search and rating filter
  const filteredFeedback = useMemo(() => {
    return feedbackWithDetails.filter((feedback) => {
      // Search filter
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch =
        searchTerm === "" ||
        feedback.comment?.toLowerCase().includes(searchLower) ||
        feedback.student_profile?.name?.toLowerCase().includes(searchLower) ||
        feedback.student_profile?.sortable_name?.toLowerCase().includes(searchLower);

      // Rating filter
      const matchesRating =
        filterRating === "all" ||
        (filterRating === "positive" && feedback.thumbs_up) ||
        (filterRating === "negative" && !feedback.thumbs_up);

      return matchesSearch && matchesRating;
    });
  }, [feedbackWithDetails, searchTerm, filterRating]);

  // Statistics
  const stats = useMemo(() => {
    const total = feedbackWithDetails.length;
    const positive = feedbackWithDetails.filter((f) => f.thumbs_up).length;
    const negative = total - positive;
    const withComments = feedbackWithDetails.filter((f) => f.comment?.trim()).length;

    return {
      total,
      positive,
      negative,
      positivePercentage: total > 0 ? Math.round((positive / total) * 100) : 0,
      withComments,
      commentsPercentage: total > 0 ? Math.round((withComments / total) * 100) : 0
    };
  }, [feedbackWithDetails]);

  const ratingFilterOptions = [
    { value: "all", label: "All Ratings" },
    { value: "positive", label: "Positive (👍)" },
    { value: "negative", label: "Negative (👎)" }
  ];

  if (feedbackWithDetails.length === 0) {
    return (
      <EmptyState.Root>
        <EmptyState.Content>
          <EmptyState.Indicator>
            <Icon as={BsChatText} />
          </EmptyState.Indicator>
          <EmptyState.Title>No Feedback Yet</EmptyState.Title>
          <EmptyState.Description>
            Students haven&apos;t submitted any feedback for help requests in this course yet.
          </EmptyState.Description>
        </EmptyState.Content>
      </EmptyState.Root>
    );
  }

  return (
    <VStack spaceY={6} align="stretch">
      <Card.Root>
        <Card.Header>
          <Heading size="lg">Help Request Feedback</Heading>
          <Text mt={2}>Student feedback helps improve the office hours experience</Text>
        </Card.Header>
        <Card.Body>
          <HStack wrap="wrap" spaceX={6} spaceY={4}>
            <VStack align="start" spaceY={1}>
              <Text fontSize="2xl" fontWeight="bold">
                {stats.total}
              </Text>
              <Text fontSize="sm">Total Feedback</Text>
            </VStack>
            <VStack align="start" spaceY={1}>
              <HStack>
                <Icon as={BsHandThumbsUp} color="green" />
                <Text fontSize="2xl" fontWeight="bold" color="green">
                  {stats.positive} ({stats.positivePercentage}%)
                </Text>
              </HStack>
              <Text fontSize="sm">Positive</Text>
            </VStack>
            <VStack align="start" spaceY={1}>
              <HStack>
                <Icon as={BsHandThumbsDown} color="red" />
                <Text fontSize="2xl" fontWeight="bold" color="red">
                  {stats.negative} ({100 - stats.positivePercentage}%)
                </Text>
              </HStack>
              <Text fontSize="sm">Negative</Text>
            </VStack>
            <VStack align="start" spaceY={1}>
              <HStack>
                <Icon as={BsChatText} />
                <Text fontSize="2xl" fontWeight="bold">
                  {stats.withComments} ({stats.commentsPercentage}%)
                </Text>
              </HStack>
              <Text fontSize="sm">With Comments</Text>
            </VStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Body>
          <HStack spaceX={4} wrap="wrap">
            <Box minW="300px">
              <HStack>
                <Icon as={BsSearch} />
                <Input
                  placeholder="Search by comment or student name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  size="sm"
                />
              </HStack>
            </Box>
            <Box minW="200px">
              <HStack>
                <Icon as={BsFilter} />
                <Select
                  options={ratingFilterOptions}
                  value={ratingFilterOptions.find((opt) => opt.value === filterRating)}
                  onChange={(option: { value: string; label: string } | null) => {
                    const value = option?.value || "all";
                    if (value === "all" || value === "positive" || value === "negative") {
                      setFilterRating(value);
                    }
                  }}
                  placeholder="Filter by rating..."
                  size="sm"
                />
              </HStack>
            </Box>
          </HStack>
        </Card.Body>
      </Card.Root>

      <VStack spaceY={4} align="stretch">
        {filteredFeedback.length === 0 ? (
          <EmptyState.Root>
            <EmptyState.Content>
              <EmptyState.Indicator>
                <Icon as={BsExclamationCircle} />
              </EmptyState.Indicator>
              <EmptyState.Title>No Matching Feedback</EmptyState.Title>
              <EmptyState.Description>
                No feedback matches your current search and filter criteria.
              </EmptyState.Description>
            </EmptyState.Content>
          </EmptyState.Root>
        ) : (
          filteredFeedback.map((feedback) => (
            <Card.Root key={feedback.id}>
              <Card.Body>
                <VStack align="stretch" spaceY={3}>
                  <HStack justify="space-between" align="start">
                    <HStack spaceX={3}>
                      <Badge
                        colorPalette={feedback.thumbs_up ? "green" : "red"}
                        size="lg"
                        display="flex"
                        alignItems="center"
                        gap={1}
                      >
                        <Icon
                          as={feedback.thumbs_up ? BsHandThumbsUp : BsHandThumbsDown}
                          color={feedback.thumbs_up ? "green" : "red"}
                        />
                      </Badge>
                      <HStack>
                        <Icon as={BsPersonFill} />
                        <Text fontWeight="medium">
                          {feedback.student_profile?.name ||
                            feedback.student_profile?.sortable_name ||
                            "Unknown Student"}
                        </Text>
                      </HStack>
                    </HStack>
                    <HStack>
                      <Icon as={BsCalendarEvent} />
                      <Text fontSize="sm">
                        {formatDistanceToNow(new Date(feedback.created_at), { addSuffix: true })}
                      </Text>
                    </HStack>
                  </HStack>

                  {feedback.comment && (
                    <Box>
                      <Text fontWeight="medium" mb={2}>
                        Comment:
                      </Text>
                      <Box p={3} borderRadius="md" data-visual-test-no-radius>
                        <Text>{feedback.comment}</Text>
                      </Box>
                    </Box>
                  )}

                  {feedback.help_request && (
                    <Box>
                      <Separator />
                      <Text fontSize="sm" fontWeight="medium" mt={3} mb={2}>
                        Help Request Context:
                      </Text>
                      <VStack align="start" spaceY={2}>
                        <Text fontSize="sm">
                          <strong>Status:</strong> {feedback.help_request.status}
                        </Text>
                        <Link
                          href={`/course/${classId}/manage/office-hours/request/${feedback.help_request.id}`}
                          style={{ textDecoration: "none" }}
                        >
                          <HStack fontSize="sm" cursor="pointer">
                            <Icon as={BsBoxArrowUpRight} />
                            <Text>View Help Request</Text>
                          </HStack>
                        </Link>
                      </VStack>
                    </Box>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
          ))
        )}
      </VStack>
    </VStack>
  );
}
