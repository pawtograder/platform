"use client";

import { Box, Container, List, Text, VStack } from "@chakra-ui/react";
import ClassLateTokenSettings from "./classLateTokenSettings";
import DueDateExceptionsTable from "./tables/dueDateExceptionsTable";

/**
 * Assignment Exceptions page - the default page for due date extensions.
 * Shows class-wide late token settings and assignment-level exceptions.
 */
export default function DueDateExtensionsPage() {
  return (
    <Container>
      <VStack align="stretch" gap={6} py={4}>
        <Box maxW="4xl" fontSize="sm" color="fg.muted">
          Pawtograder&apos;s due date exception model is quite flexible:
          <List.Root as="ul">
            <List.Item>
              All students in a class get a set number of late tokens (configured on this page) that can be applied for
              a 24-hour extension. On each assignment, instructors specify how many tokens can be used.
            </List.Item>
            <List.Item>
              Instructors can directly enter exceptions that apply to all of a student&apos;s assignments, or to a
              specific assignment.
            </List.Item>
            <List.Item>
              Instructors can gift additional tokens to students, to be used at the student&apos;s discretion (to gift
              to ALL students, simply increase the number of tokens allocated by default for the class).
            </List.Item>
          </List.Root>
          <Text>Important notes on Pawtograder&apos;s due date exception model:</Text>
          <List.Root as="ul">
            <List.Item>
              Student token balances are defined exactly as: The number of tokens allocated by default for the class,
              less tokens used, plus any additional tokens granted. Increasing the default number of tokens will affect
              all existing token balances.
            </List.Item>
            <List.Item>
              On a group assignment, any student in the group with a token can use that token to extend the due date for
              the entire group. If a groupmate has 0 tokens, they will still get the extension. All group members will
              have a token deducted. Student token balances are allowed to become negative.
            </List.Item>
          </List.Root>
        </Box>
        <ClassLateTokenSettings />
        <DueDateExceptionsTable />
      </VStack>
    </Container>
  );
}
