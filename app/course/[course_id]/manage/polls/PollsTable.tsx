"use client";

import { Box, Table, Text, Badge, HStack, IconButton, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import Link from "@/components/ui/link";
import { formatInTimeZone } from "date-fns-tz";
import { MenuRoot, MenuTrigger, MenuContent, MenuItem } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { useCallback, useState, useMemo } from "react";
import { HiOutlineDotsHorizontal } from "react-icons/hi";
import { FaTrash } from "react-icons/fa";

type LivePollRecord = {
  id: string;
  class_id: number;
  created_by: string;
  title: string;
  question: Record<string, unknown> | null;
  is_live: boolean;
  created_at: string;
};

export type LivePollWithCounts = LivePollRecord & {
  response_count: number;
};

type PollsTableProps = {
  polls: LivePollWithCounts[];
  courseId: string;
  timezone: string;
};

type FilterType = "all" | "live" | "closed";

export default function PollsTable({ polls, courseId, timezone }: PollsTableProps) {
  const [pollRows, setPollRows] = useState<LivePollWithCounts[]>(polls);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  const textColor = useColorModeValue("#1A202C", "#FFFFFF");
  const secondaryTextColor = useColorModeValue("#4B5563", "#A0AEC0");
  const tableBorderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tableHeaderBg = useColorModeValue("#F2F2F2", "#0D0D0D");
  const tableHeaderTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");
  const actionsButtonBorder = useColorModeValue("#D2D2D2", "#2D2D2D");
  const filterButtonActiveBg = useColorModeValue("#3B82F6", "#2563EB");
  const filterButtonActiveColor = "#FFFFFF";
  const filterButtonInactiveBg = useColorModeValue("#F2F2F2", "#374151");
  const filterButtonInactiveColor = useColorModeValue("#4B5563", "#9CA3AF");
  const filterButtonHoverBg = useColorModeValue("#E5E5E5", "#4B5563");

  const filteredPolls = useMemo(() => {
    if (activeFilter === "all") {
      return pollRows;
    }
    return pollRows.filter((poll) => (activeFilter === "live" ? poll.is_live : !poll.is_live));
  }, [pollRows, activeFilter]);

  const getStatusBadge = (isLive: boolean) => {
    const colors = isLive
      ? { text: "#22C55E", bg: "rgba(34, 197, 94, 0.2)", label: "Live" }
      : { text: "#EF4444", bg: "rgba(239, 68, 68, 0.2)", label: "Closed" };

    return (
      <Badge
        px={2}
        py={1}
        borderRadius="md"
        fontSize="xs"
        fontWeight="medium"
        bg={colors.bg}
        color={colors.text}
      >
        {colors.label}
      </Badge>
    );
  };

  const summarizeQuestion = (question: Record<string, unknown> | null) => {
    if (!question) {
      return "—";
    }
    try {
      const serialized = JSON.stringify(question);
      if (serialized.length <= 80) {
        return serialized;
      }
      return `${serialized.slice(0, 80)}…`;
    } catch {
      return "—";
    }
  };

  const handleToggleLive = useCallback(async (pollId: string, nextState: boolean) => {
    const supabase = createClient();
    const loadingToast = toaster.create({
      title: nextState ? "Starting Poll" : "Closing Poll",
      description: nextState ? "Making poll available to students..." : "Closing poll for students...",
      type: "loading"
    });

    try {
      const { error } = await supabase
        .from("live_polls" as any)
        .update({ is_live: nextState })
        .eq("id", pollId);

      if (error) {
        throw new Error(error.message);
      }

      setPollRows((prev) => prev.map((poll) => (poll.id === pollId ? { ...poll, is_live: nextState } : poll)));

      toaster.dismiss(loadingToast);
      toaster.create({
        title: nextState ? "Poll is Live" : "Poll Closed",
        description: nextState
          ? "Students can now answer this poll."
          : "Students can no longer submit responses.",
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

  const handleDelete = useCallback(async (pollId: string, pollTitle: string) => {
    const confirmed = confirm(`Are you sure you want to delete "${pollTitle}"? This action cannot be undone.`);
    if (!confirmed) return;

    const loadingToast = toaster.create({
      title: "Deleting Poll",
      description: "Removing poll and all responses...",
      type: "loading"
    });

    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("live_polls" as any)
        .delete()
        .eq("id", pollId);

      if (error) {
        throw new Error(error.message);
      }

      setPollRows((prev) => prev.filter((poll) => poll.id !== pollId));

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

  const formatDate = (dateString: string) => {
    try {
      return formatInTimeZone(new Date(dateString), timezone, "MMM d, yyyy 'at' h:mm a");
    } catch {
      return dateString;
    }
  };

  return (
    <>
      {/* Filter Buttons */}
      <HStack gap={2} mb={4}>
        {(["all", "live", "closed"] as FilterType[]).map((filter) => (
          <Button
            key={filter}
            size="sm"
            variant="outline"
            bg={activeFilter === filter ? filterButtonActiveBg : filterButtonInactiveBg}
            color={activeFilter === filter ? filterButtonActiveColor : filterButtonInactiveColor}
            borderColor={tableBorderColor}
            _hover={{ bg: filterButtonHoverBg }}
            onClick={() => setActiveFilter(filter)}
            textTransform="capitalize"
          >
            {filter}
          </Button>
        ))}
      </HStack>

      <Box border="1px solid" borderColor={tableBorderColor} borderRadius="lg" overflow="hidden">
        <Table.Root size="sm" variant="plain">
          <Table.Header bg={tableHeaderBg}>
            <Table.Row>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold">
                Title
              </Table.ColumnHeader>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold">
                Question Preview
              </Table.ColumnHeader>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold">
                Status
              </Table.ColumnHeader>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold">
                Responses
              </Table.ColumnHeader>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold">
                Created
              </Table.ColumnHeader>
              <Table.ColumnHeader color={tableHeaderTextColor} fontWeight="semibold" textAlign="center">
                Actions
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {filteredPolls.map((poll) => (
              <Table.Row key={poll.id} bg={tableRowBg}>
                <Table.Cell>
                  <Link href={`/course/${courseId}/manage/polls/${poll.id}/responses`}>
                    <Text fontWeight="medium" color={textColor}>
                      {poll.title}
                    </Text>
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm" color={secondaryTextColor} noOfLines={1}>
                    {summarizeQuestion(poll.question)}
                  </Text>
                </Table.Cell>
                <Table.Cell>{getStatusBadge(poll.is_live)}</Table.Cell>
                <Table.Cell>
                  <Text fontSize="sm" color={textColor}>
                    {poll.response_count}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Text fontSize="xs" color={secondaryTextColor}>
                    {formatDate(poll.created_at)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <HStack gap={2} justifyContent="center">
                    <MenuRoot>
                      <MenuTrigger asChild>
                        <IconButton
                          size="sm"
                          variant="ghost"
                          aria-label="Poll actions"
                          borderColor={actionsButtonBorder}
                        >
                          <HiOutlineDotsHorizontal />
                        </IconButton>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem
                          onClick={() => handleToggleLive(poll.id, !poll.is_live)}
                        >
                          {poll.is_live ? "Close Poll" : "Open Poll"}
                        </MenuItem>
                        <MenuItem
                          onClick={() => handleDelete(poll.id, poll.title)}
                          colorPalette="red"
                        >
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

