"use client";

import { Box, Table, Text, Button } from "@chakra-ui/react";
import { Database } from "@/utils/supabase/SupabaseTypes";

type LivePoll = Database["public"]["Tables"]["live_polls"]["Row"];

type StudentPollsTableProps = {
  polls: LivePoll[];
  onPollClick: () => void;
};

export default function StudentPollsTable({ polls, onPollClick }: StudentPollsTableProps) {

  const getQuestionPrompt = (poll: LivePoll) => {
    const questionData = poll.question as unknown as Record<string, unknown> | null;
    return (questionData?.elements as unknown as { title: string }[])?.[0]?.title || "Poll";
  };

  return (
    <Box border="1px solid" borderColor="border" borderRadius="lg" overflow="hidden">
      <Table.Root size="sm">
        <Table.Header bg="bg.muted">
          <Table.Row>
            <Table.ColumnHeader
              color="fg.muted"
              fontWeight="semibold"
              textAlign="left"
              pl={4}
              pr={4}
              py={3}
            >
              Question
            </Table.ColumnHeader>
            <Table.ColumnHeader
              color="fg.muted"
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
            <Table.Row key={poll.id} bg="bg.subtle">
              <Table.Cell pl={4} pr={4} py={3}>
                <Text fontWeight="medium" color="fg">
                  {getQuestionPrompt(poll)}
                </Text>
              </Table.Cell>
              <Table.Cell pl={2} pr={4} py={3} textAlign="right">
                <Button size="sm" bg="green.500" color="white" _hover={{ bg: "green.600" }} onClick={onPollClick}>
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
