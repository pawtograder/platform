"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Box, Table, Text, Badge, HStack, IconButton, Button } from "@chakra-ui/react";
import Link from "@/components/ui/link";
import { MenuRoot, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { useCallback, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { FaTrash } from "react-icons/fa";
import { useLivePolls, useCourse, useCourseController } from "@/hooks/useCourseController";
import { Database } from "@/utils/supabase/SupabaseTypes";

type LivePoll = Database["public"]["Tables"]["live_polls"]["Row"];

type FilterType = "all" | "live" | "closed";

type PollsTableProps = {
  courseId: string;
};

export default function PollsTable({ courseId }: PollsTableProps) {
  const router = useRouter();
  const polls = useLivePolls();
  const course = useCourse();
  const { livePolls } = useCourseController();
  const timezone = course?.time_zone || "America/New_York";
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  const filteredPolls = useMemo(() => {
    if (activeFilter === "all") {
      return polls;
    }
    return polls.filter((poll) => (activeFilter === "live" ? poll.is_live : !poll.is_live));
  }, [polls, activeFilter]);

  const getQuestionPrompt = (poll: LivePoll) => {
    const questionData = poll.question as unknown as Record<string, unknown> | null;
    return (questionData?.elements as unknown as { title: string }[])?.[0]?.title || "Poll";
  };

  const getStatusBadge = (isLive: boolean) => {
    return (
      <Badge
        px={2}
        py={1}
        borderRadius="md"
        fontSize="xs"
        fontWeight="medium"
        colorPalette={isLive ? "green" : "red"}
        bg={isLive ? "green.subtle" : "red.subtle"}
        color={isLive ? "green.500" : "red.500"}
      >
        {isLive ? "Live" : "Closed"}
      </Badge>
    );
  };

  const handleToggleLive = useCallback(async (pollId: string, nextState: boolean) => {
    const loadingToast = toaster.create({
      title: nextState ? "Starting Poll" : "Closing Poll",
      description: nextState ? "Making poll available to students..." : "Closing poll for students...",
      type: "loading"
    });

    try {
      // If making poll live, set deactivates_at to 1 hour from now
      // If closing poll, clear deactivates_at
      const updateData: { is_live: boolean; deactivates_at: string | null } = {
        is_live: nextState,
        deactivates_at: nextState
          ? new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour from now
          : null
      };

      await livePolls.update(pollId, updateData);

      toaster.dismiss(loadingToast);
      toaster.create({
        title: nextState ? "Poll is Live" : "Poll Closed",
        description: nextState ? "Students can now answer this poll." : "Students can no longer submit responses.",
        type: "success"
      });
    } catch (err) {
      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Unable to update poll",
        description: err instanceof Error ? err.message : "An unexpected error occurred",
        type: "error"
      });
    }
  }, []);

  const handleDelete = useCallback(async (pollId: string) => {
    const confirmed = confirm(`Are you sure you want to delete this poll? This action cannot be undone.`);
    if (!confirmed) return;

    const loadingToast = toaster.create({
      title: "Deleting Poll",
      description: "Removing poll and all responses...",
      type: "loading"
    });
    try {
      await livePolls.hardDelete(pollId);

      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Poll Deleted",
        description: "The poll and all its responses have been deleted.",
        type: "success"
      });
    } catch (err) {
      toaster.dismiss(loadingToast);
      toaster.create({
        title: "Unable to delete poll",
        description: err instanceof Error ? err.message : "An unexpected error occurred",
        type: "error"
      });
    }
  }, []);


  return (
    <>
      {/* Filter Buttons */}
      <HStack gap={2} mb={4}>
        {(["all", "live", "closed"] as FilterType[]).map((filter) => (
          <Button
            key={filter}
            size="sm"
            variant="outline"
            bg={activeFilter === filter ? "blue.500" : "bg.subtle"}
            color={activeFilter === filter ? "white" : "fg.muted"}
            borderColor={activeFilter === filter ? "blue.500" : "border"}
            _hover={{ bg: activeFilter === filter ? "blue.500" : "bg.muted" }}
            onClick={() => setActiveFilter(filter)}
            textTransform="capitalize"
          >
            {filter}
          </Button>
        ))}
      </HStack>

      <Box border="1px solid" borderColor="border" borderRadius="lg" overflow="hidden">
        <Table.Root size="sm">
          <Table.Header bg="bg.muted">
            <Table.Row>
              <Table.ColumnHeader color="fg.muted" fontWeight="semibold">
                Question
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontWeight="semibold">
                Status
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontWeight="semibold">
                Created
              </Table.ColumnHeader>
              <Table.ColumnHeader color="fg.muted" fontWeight="semibold" textAlign="center">
                Actions
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filteredPolls.map((poll) => (
              <Table.Row key={poll.id} bg="bg.subtle">
                <Table.Cell>
                  <Link href={`/course/${courseId}/manage/polls/${poll.id}/responses`}>
                    <Text fontWeight="medium" color="fg.default">
                      {getQuestionPrompt(poll)}
                    </Text>
                  </Link>
                </Table.Cell>
                <Table.Cell>{getStatusBadge(poll.is_live)}</Table.Cell>
                <Table.Cell>
                  <Text fontSize="xs" color="fg.muted">
                    <TimeZoneAwareDate date={poll.created_at} format="MMM d, yyyy, h:mm a" />
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <HStack gap={2} justifyContent="center">
                    <MenuRoot>
                      <MenuTrigger asChild>
                        <IconButton size="sm" variant="ghost" aria-label="Poll actions" borderColor="border.default">
                          <HiOutlineDotsHorizontal />
                        </IconButton>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem
                          value={poll.is_live ? "close" : "open"}
                          onClick={() => handleToggleLive(poll.id, !poll.is_live)}
                        >
                          {poll.is_live ? "Close Poll" : "Open Poll"}
                        </MenuItem>
                        <MenuItem
                          value="view"
                          onClick={() => router.push(`/course/${courseId}/manage/polls/${poll.id}/responses`)}
                        >
                          View Poll
                        </MenuItem>
                        <MenuItem value="delete" onClick={() => handleDelete(poll.id)} colorPalette="red">
                          <FaTrash />
                          Delete Poll
                        </MenuItem>
                      </MenuContent>
                    </MenuRoot>
                  </HStack>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </>
  );
}
