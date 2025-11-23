"use client";

import { Box, Heading, Text, VStack, HStack, IconButton } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { createClient } from "@/utils/supabase/client";
import { useParams } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { toaster } from "@/components/ui/toaster";
import { LivePoll } from "@/types/poll";
import { LuRefreshCw } from "react-icons/lu";
import StudentPollsTable from "./StudentPollsTable";

export default function StudentPollsPage() {
  const { course_id } = useParams();
  const [polls, setPolls] = useState<LivePoll[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Color mode values
  const textColor = useColorModeValue("#000000", "#FFFFFF");
  const borderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const cardBgColor = useColorModeValue("#E5E5E5", "#1A1A1A");
  const buttonTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const buttonBorderColor = useColorModeValue("#6B7280", "#4A5568");

  const fetchPolls = useCallback(async () => {
    try {
      const supabase = createClient();

      // Get current user
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

      // Resolve this user's class-specific public_profile_id for this course
      const { data: roleDataRaw, error: roleError } = await supabase
        .from("user_roles")
        .select("public_profile_id, role")
        .eq("user_id", user.id)
        .eq("class_id", Number(course_id))
        .eq("role", "student")
        .eq("disabled", false)
        .single();

      // Tell TypeScript what we actually expect from that query
      const roleData = roleDataRaw as { public_profile_id: string; role: string } | null;

      if (roleError || !roleData || !roleData.public_profile_id) {
        toaster.create({
          title: "Access Error",
          description: "This page is only accessible to students enrolled in this course.",
          type: "error"
        });
        setIsLoading(false);
        return;
      }

      // Get live polls for this course
      const { data: pollsData, error: pollsError } = await supabase
        .from("live_polls")
        .select("*")
        .eq("class_id", Number(course_id))
        .eq("is_live", true)
        .order("created_at", { ascending: false });

      if (pollsError) {
        throw pollsError;
      }

      setPolls(pollsData || []);
    } catch (error) {
      console.error("Error loading polls:", error);
      toaster.create({
        title: "Error Loading Polls",
        description: "An error occurred while loading polls.",
        type: "error"
      });
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [course_id]);

  useEffect(() => {
    fetchPolls();
  }, [fetchPolls]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchPolls();
  };

  const handlePollClick = () => {
    window.open(`/poll/${course_id}`, "_blank");
  };

  return (
    <Box py={8} maxW="1200px" my={2} mx="auto">
      <VStack align="stretch" gap={6} w="100%">
        {/* Header */}
        {!isLoading && (
          <VStack align="stretch" gap={4}>
            <HStack justify="space-between" align="center">
              <VStack align="start" gap={2} flex={1}>
                <Heading size="xl" color={textColor} textAlign="left">
                  Live Polls
                </Heading>
                <Text color={textColor} fontSize="md" opacity={0.8}>
                  Participate in live polls for this course.
                </Text>
              </VStack>
              <IconButton
                aria-label="Refresh polls"
                onClick={handleRefresh}
                loading={isRefreshing}
                variant="outline"
                bg="transparent"
                borderColor={buttonBorderColor}
                color={buttonTextColor}
                _hover={{ bg: "rgba(160, 174, 192, 0.1)" }}
              >
                <LuRefreshCw />
              </IconButton>
            </HStack>
          </VStack>
        )}

        {/* Content */}
        {isLoading ? (
          <Box display="flex" alignItems="center" justifyContent="center" p={8}>
            <Text>Loading polls...</Text>
          </Box>
        ) : polls.length === 0 ? (
          <Box
            w="100%"
            maxW="800px"
            bg={cardBgColor}
            border="1px solid"
            borderColor={borderColor}
            borderRadius="lg"
            p={8}
          >
            <VStack align="center" gap={4}>
              <Heading size="xl" color={textColor} textAlign="center">
                No Live Polls Available
              </Heading>
              <Text color={textColor} textAlign="center">
                There are currently no live polls available for this course.
              </Text>
            </VStack>
          </Box>
        ) : (
          <StudentPollsTable polls={polls} onPollClick={handlePollClick} />
        )}
      </VStack>
    </Box>
  );
}
