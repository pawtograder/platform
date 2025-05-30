"use client";
import { Alert } from "@/components/ui/alert";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import { Switch } from "@/components/ui/switch";
import type { GraderResultOutput, SubmissionWithGraderResults } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  Container,
  Heading,
  HStack,
  Skeleton,
  Table,
  Tabs,
  Text
} from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useParams } from "next/navigation";
import { Fragment, useState } from "react";

export type GraderResultTestData = {
  hide_score?: string;
  icon?: string;
};
function format_result_output(result: { output: string | null | undefined; output_format: string | null | undefined }) {
  if (result.output === undefined && result.output_format === undefined) {
    return (
      <Text textStyle="sm" color="text.muted">
        No output
      </Text>
    );
  }
  if (result.output_format === "text" || result.output_format === null) {
    return (
      <Box fontSize="sm" overflowX="auto">
        <pre>{result.output}</pre>
      </Box>
    );
  }
  if (result.output_format === "markdown") {
    return (
      <Box fontSize="sm" overflowX="auto">
        <Markdown>{result.output}</Markdown>
      </Box>
    );
  }
  return <Text fontSize="sm">{result.output}</Text>;
}

function format_output(output: GraderResultOutput) {
  return format_result_output({ output: output.output, output_format: output.format as "text" | "markdown" });
}

export default function GraderResults() {
  const { submissions_id } = useParams();
  const { query } = useShow<SubmissionWithGraderResults>({
    resource: "submissions",
    id: Number(submissions_id),
    meta: {
      select:
        "*, assignments(*), grader_results(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*))"
    }
  });
  const [showHiddenOutput, setShowHiddenOutput] = useState(true);
  if (query.isLoading) {
    return (
      <Box>
        <Skeleton height="100px" />
      </Box>
    );
  }
  if (query.error) {
    return (
      <Box>
        Error loading grader results
        {query.error.message}
      </Box>
    );
  }
  if (!query.data) {
    return <Box>No grader results found</Box>;
  }
  if (query.data.data.grader_results?.errors) {
    const errors = query.data.data.grader_results.errors;
    const userVisibleMessage =
      typeof errors === "object" && "user_visible_message" in errors ? errors.user_visible_message : null;
    return (
      <Box>
        <Alert title="Submission Error" status="error" p={4} m={4}>
          An error occurred while creating the submission. Your code has not been submitted, although a record will
          still exist <Link href={`https://github.com/${query.data.data.repository}`}>in your GitHub repository</Link>.
          {userVisibleMessage && (
            <Box p={2} fontWeight="bold">
              Error: {String(userVisibleMessage)}
            </Box>
          )}
        </Alert>
      </Box>
    );
  }
  if (!query.data.data.grader_results) {
    return (
      <Container>
        <Box w="4xl" p={4} m={4}>
          <Alert title="Autograder has not finished running">
            The autograder started running {formatDistanceToNow(query.data.data.created_at, { addSuffix: true })}, and
            has not completed yet. Please check{" "}
            <Link
              href={`https://github.com/${query.data.data.repository}/actions/runs/${query.data.data.run_number}/attempts/${query.data.data.run_attempt}`}
            >
              the GitHub Actions run for this submission
            </Link>{" "}
            to see if it has completed, and share the link with your instructor.
          </Alert>
        </Box>
      </Container>
    );
  }
  const hasHiddenOutput = query.data.data.grader_results.grader_result_tests.some(
    (result) => result.grader_result_test_output.length > 0 || !result.is_released
  );
  const data = query.data.data;
  return (
    <Tabs.Root m={3} defaultValue="tests">
      <Tabs.List>
        <Tabs.Trigger value="tests">Test Results</Tabs.Trigger>
        {data.grader_results?.grader_result_output?.map((output) => (
          <Tabs.Trigger key={output.id} value={output.visibility}>
            {data.grader_results?.grader_result_output.length === 1
              ? "Output"
              : output.visibility === "visible"
                ? "Student Visible Output"
                : "Instructor-Only Debug Output"}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {data.grader_results?.grader_result_output?.map((output) => (
        <Tabs.Content key={output.id} value={output.visibility}>
          {format_output(output)}
        </Tabs.Content>
      ))}
      <Tabs.Content value="tests">
        <Heading size="md">Lint Results: {data.grader_results?.lint_passed ? "Passed" : "Failed"}</Heading>
        {data.grader_results?.lint_output && (
          <Box borderWidth="1px" borderRadius="md" p={2}>
            <Heading size="sm">Lint Output</Heading>
            <Box maxH="400px" overflow="auto">
              {format_result_output({
                output: data.grader_results?.lint_output,
                output_format: data.grader_results?.lint_output_format
              })}
            </Box>
          </Box>
        )}
        <Heading size="md">Test Results</Heading>
        <HStack w="100%" justifyContent="flex-end">
          {hasHiddenOutput && (
            <Switch
              checked={showHiddenOutput}
              onChange={() => setShowHiddenOutput(!showHiddenOutput)}
              colorPalette="green"
            >
              Instructor View
            </Switch>
          )}
        </HStack>
        <Table.Root maxW="2xl">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader>Name</Table.ColumnHeader>
              <Table.ColumnHeader>Score</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.grader_results?.grader_result_tests &&
              data.grader_results?.grader_result_tests.length > 0 &&
              data.grader_results?.grader_result_tests[0]?.part && (
                <Table.Row>
                  <Table.Cell bg="bg.muted" colSpan={3} fontWeight="bold" textAlign="center">
                    {data.grader_results?.grader_result_tests[0]?.part}
                  </Table.Cell>
                </Table.Row>
              )}
            {data.grader_results?.grader_result_tests
              ?.filter(
                (r) =>
                  (r.extra_data as GraderResultTestData)?.hide_score !== "true" && (showHiddenOutput || r.is_released)
              )
              .map((result, index) => {
                const isNewPart =
                  index > 0 && result.part !== data.grader_results?.grader_result_tests[index - 1]?.part;
                return (
                  <Fragment key={result.id}>
                    {isNewPart && (
                      <Table.Row>
                        <Table.Cell colSpan={3} textAlign="center" bg="bg.muted" fontWeight="bold">
                          {result.part}
                        </Table.Cell>
                      </Table.Row>
                    )}
                    <Table.Row>
                      <Table.Cell>{result.score === result.max_score ? "✅" : "❌"}</Table.Cell>
                      <Table.Cell>
                        <Link variant="underline" href={`#test-${result.id}`}>
                          {result.name}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        {result.score}/{result.max_score}
                      </Table.Cell>
                    </Table.Row>
                  </Fragment>
                );
              })}
          </Table.Body>
        </Table.Root>
        {data.grader_results?.grader_result_tests
          ?.filter((result) => result.is_released || showHiddenOutput)
          .map((result) => {
            const hasInstructorOutput = showHiddenOutput && result.grader_result_test_output.length > 0;
            const maybeWrappedResult = (content: React.ReactNode) => {
              if (hasInstructorOutput) {
                return (
                  <CardRoot key={result.id} m={2}>
                    <CardHeader bg="bg.muted" p={2}>
                      <Heading size="md">Student-Visible Output</Heading>
                    </CardHeader>
                    <CardBody>{content}</CardBody>
                  </CardRoot>
                );
              }
              return <CardBody>{content}</CardBody>;
            };
            const style = result.max_score === 0 ? "info" : result.score === result.max_score ? "success" : "error";
            const showScore = result.max_score !== 0;
            return (
              <CardRoot key={result.id} id={`test-${result.id}`} mt={4}>
                <CardHeader bg={`bg.${style}`} p={2}>
                  <Heading size="lg" color={`fg.${style}`}>
                    {result.name} {showScore ? result.score + "/" + result.max_score : ""}
                  </Heading>
                </CardHeader>
                {maybeWrappedResult(format_result_output(result))}
                {hasInstructorOutput &&
                  result.grader_result_test_output.map((output) => (
                    <CardRoot key={output.id} m={2}>
                      <CardHeader bg="bg.muted" p={2}>
                        <Heading size="md">Instructor-Only Output</Heading>
                      </CardHeader>
                      <CardBody>{format_result_output(output)}</CardBody>
                    </CardRoot>
                  ))}
              </CardRoot>
            );
          })}
      </Tabs.Content>
    </Tabs.Root>
  );
}
