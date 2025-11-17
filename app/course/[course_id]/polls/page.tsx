"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { Box, Heading, Text, VStack, Button, Badge, HStack } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { LivePoll } from "@/types/poll";
import Link from "@/components/ui/link";

type PollWithStatus = LivePoll & {
  response_status: "not_started" | "in_progress" | "completed";
};

type FilterType = "all" | "live" | "answered";

const responseStatusStyles: Record<PollWithStatus["response_status"], { bg: string; color: string; text: string }> = {
  not_started: {
    bg: "rgba(239, 68, 68, 0.2)",
    color: "#EF4444",
    text: "Not Started"
  },
  in_progress: {
    bg: "rgba(251, 191, 36, 0.2)",
    color: "#FBBF24",
    text: "In Progress"
  },
  completed: {
    bg: "rgba(34, 197, 94, 0.2)",
    color: "#22C55E",
    text: "Completed"
  }
};

export default function StudentPollsPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const { public_profile_id } = useClassProfiles();
  const [polls, setPolls] = useState<PollWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");
  const closedColor = useColorModeValue("#4B5563", "#FFFFFF");

  useEffect(() => {
    const loadPolls = async () => {
      try {
        const supabase = createClient();
        const {
          data: { user }
        } = await supabase.auth.getUser();

        if (!user) {
          toaster.create({
            title: "Authentication Required",
            description: "Please log in to view polls.",
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        const { data: roleDataRaw, error: roleError } = await supabase
          .from("user_roles" as any)
          .select("public_profile_id")
          .eq("user_id", user.id)
          .eq("class_id", Number(course_id))
          .eq("role", "student")
          .eq("disabled", false)
          .single();

        const roleData = roleDataRaw as { public_profile_id: string } | null;

        if (roleError || !roleData?.public_profile_id) {
          toaster.create({
            title: "Access Error",
            description: "We couldn't find your course profile.",
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        const publicProfileId = roleData.public_profile_id;

        const { data: pollsData, error: pollsError } = await supabase
          .from("live_polls" as any)
          .select("*")
          .eq("class_id", Number(course_id))
          .order("created_at", { ascending: false });

        if (pollsError) {
          throw pollsError;
        }

        const typedPolls = ((pollsData ?? []) as unknown) as LivePoll[];

        if (typedPolls.length === 0) {
          setPolls([]);
          setIsLoading(false);
          return;
        }

        const { data: responsesData, error: responsesError } = await supabase
          .from("live_poll_responses" as any)
          .select("*")
          .eq("public_profile_id", publicProfileId)
          .in(
            "live_poll_id",
            typedPolls.map((poll) => poll.id)
          );

        if (responsesError) {
          throw responsesError;
        }

        const responses = (responsesData || []) as Array<{ live_poll_id: string; is_submitted: boolean }>;
        const responseMap = new Map(
          responses.map((r) => [r.live_poll_id, r.is_submitted])
        );

        const pollsWithStatus: PollWithStatus[] = typedPolls.map((poll) => {
          const hasResponse = responseMap.has(poll.id);
          const isSubmitted = responseMap.get(poll.id) === true;

          let response_status: PollWithStatus["response_status"];
          if (isSubmitted) {
            response_status = "completed";
          } else if (hasResponse) {
            response_status = "in_progress";
          } else {
            response_status = "not_started";
          }

          return {
            ...poll,
            response_status
          };
        });

        setPolls(pollsWithStatus);
      } catch (error) {
        console.error("Error loading polls:", error);
        toaster.create({
          title: "Error Loading Polls",
          description: "An error occurred while loading polls.",
          type: "error"
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadPolls();
  }, [course_id, public_profile_id]);

  const filteredPolls = useMemo(() => {
    if (activeFilter === "all") {
      return polls;
    } else if (activeFilter === "live") {
      return polls.filter((poll) => poll.is_live);
    } else {
      // answered
      return polls.filter((poll) => poll.response_status === "completed");
    }
  }, [polls, activeFilter]);

  if (isLoading) {
    return (
      <Box py={8} maxW="1200px" my={2} mx="auto">
        <Text>Loading polls...</Text>
      </Box>
    );
  }

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        <VStack align="stretch" gap={4}>
          <Heading size="xl" color={textColor} textAlign="left">
            Polls
          </Heading>
          <Text fontSize="sm" color={buttonTextColor}>
            Participate in live polls from your instructor.
          </Text>
        </VStack>

        {/* Filter Buttons */}
        <HStack gap={2}>
          {(["all", "live", "answered"] as FilterType[]).map((filter) => (
            <Button
              key={filter}
              size="sm"
              variant="outline"
              bg={activeFilter === filter ? "blue.500" : "transparent"}
              color={activeFilter === filter ? "white" : buttonTextColor}
              borderColor={buttonBorderColor}
              _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              onClick={() => setActiveFilter(filter)}
              textTransform="capitalize"
            >
              {filter}
            </Button>
          ))}
        </HStack>

        {/* Polls List */}
        {filteredPolls.length === 0 ? (
          <Box
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={12}
            textAlign="center"
          >
            <Text fontSize="lg" color={textColor} mb={2}>
              No polls available
            </Text>
            <Text fontSize="sm" color={buttonTextColor}>
              {activeFilter === "live"
                ? "There are no live polls at the moment."
                : activeFilter === "answered"
                ? "You haven't answered any polls yet."
                : "No polls have been created yet."}
            </Text>
          </Box>
        ) : (
          <VStack align="stretch" gap={4}>
            {filteredPolls.map((poll) => {
              const statusStyle = responseStatusStyles[poll.response_status];
              const canRespond = poll.is_live && poll.response_status !== "completed";

              return (
                <Box
                  key={poll.id}
                  bg={cardBgColor}
                  border="1px solid"
                  borderColor={borderColor}
                  borderRadius="lg"
                  p={6}
                >
                  <VStack align="stretch" gap={4}>
                    <HStack justify="space-between">
                      <VStack align="start" gap={1} flex={1}>
                        <Heading size="md" color={textColor}>
                          {poll.title}
                        </Heading>
                        <HStack gap={2}>
                          <Badge
                            px={2}
                            py={1}
                            borderRadius="md"
                            fontSize="xs"
                            fontWeight="medium"
                            bg={poll.is_live ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)"}
                            color={poll.is_live ? "#22C55E" : "#EF4444"}
                          >
                            {poll.is_live ? "Live" : "Closed"}
                          </Badge>
                          <Badge
                            px={2}
                            py={1}
                            borderRadius="md"
                            fontSize="xs"
                            fontWeight="medium"
                            bg={statusStyle.bg}
                            color={statusStyle.color}
                          >
                            {statusStyle.text}
                          </Badge>
                        </HStack>
                      </VStack>
                      {canRespond && (
                        <Button
                          size="sm"
                          bg="#22C55E"
                          color="white"
                          _hover={{ bg: "#16A34A" }}
                          onClick={() => router.push(`/course/${course_id}/polls/${poll.id}`)}
                        >
                          Answer Poll
                        </Button>
                      )}
                      {poll.response_status === "completed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          bg="transparent"
                          borderColor={buttonBorderColor}
                          color={buttonTextColor}
                          _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
                          onClick={() => router.push(`/course/${course_id}/polls/${poll.id}`)}
                        >
                          View Response
                        </Button>
                      )}
                    </HStack>
                  </VStack>
                </Box>
              );
            })}
          </VStack>
        )}
      </VStack>
    </Box>
  );
}

