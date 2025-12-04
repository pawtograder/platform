"use client";

import { Box, Table, Text, Button } from "@chakra-ui/react";
import { useColorModeValue } from "@/components/ui/color-mode";
import { Database } from "@/utils/supabase/SupabaseTypes";

type LivePoll = Database["public"]["Tables"]["live_polls"]["Row"];

type StudentPollsTableProps = {
  polls: LivePoll[];
  onPollClick: () => void;
};

export default function StudentPollsTable({ polls, onPollClick }: StudentPollsTableProps) {
  const textColor = useColorModeValue("#1A202C", "#FFFFFF");
  const tableBorderColor = useColorModeValue("#D2D2D2", "#2D2D2D");
  const tableHeaderBg = useColorModeValue("#F2F2F2", "#0D0D0D");
  const tableHeaderTextColor = useColorModeValue("#1A202C", "#9CA3AF");
  const tableRowBg = useColorModeValue("#E5E5E5", "#1A1A1A");

  const getQuestionPrompt = (poll: LivePoll) => {
    const questionData = poll.question as unknown as Record<string, unknown> | null;
    return (questionData?.elements as unknown as { title: string }[])?.[0]?.title || "Poll";
  };

  return (
    <Box border="1px solid" borderColor={tableBorderColor} borderRadius="lg" overflow="hidden">
      <Table.Root size="sm">
        <Table.Header bg={tableHeaderBg}>
          <Table.Row>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontWeight="semibold"
              textAlign="left"
              pl={4}
              pr={4}
              py={3}
            >
              Question
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color={tableHeaderTextColor}
              fontWeight="semibold"
              textAlign="right"
              pl={2}
              pr={4}
              py={3}
            >
              Action
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {polls.map((poll) => (
            <Table.Row key={poll.id} bg={tableRowBg}>
              <Table.Cell pl={4} pr={4} py={3}>
                <Text fontWeight="medium" color={textColor}>
                  {getQuestionPrompt(poll)}
                </Text>
              </Table.Cell>
              <Table.Cell pl={2} pr={4} py={3} textAlign="right">
                <Button size="sm" bg="#22C55E" color="white" _hover={{ bg: "#16A34A" }} onClick={onPollClick}>
                  Answer Poll
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}