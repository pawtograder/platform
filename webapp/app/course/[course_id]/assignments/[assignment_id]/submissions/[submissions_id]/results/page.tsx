'use client'
import Link from "@/components/ui/link";
import { GraderResultOutput, GraderResultTest, SubmissionWithGraderResults } from "@/utils/supabase/DatabaseTypes";
import { Box, CardBody, CardHeader, CardRoot, List, Skeleton, Tabs, Text, Heading, Table, HStack } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import { Fragment } from "react";
import Markdown from "react-markdown";
import { useParams } from "next/navigation";
function format_result_output(result: { output: string | null | undefined, output_format: string | null | undefined }) {
    if (result.output === undefined && result.output_format === undefined) {
        return <Text textStyle="sm" color="text.muted">No output</Text>;
    }
    if (result.output_format === "text" || result.output_format === null) {
        return <Box
            fontSize="sm"
        >
            <pre>{result.output}</pre>
        </Box>
    }
    if (result.output_format === "markdown") {
        return <Box
            fontSize="sm"
        >
            <Markdown
            >{result.output}</Markdown>
        </Box>
    }
    return <Text fontSize="sm">{result.output}</Text>
}
function format_output(output: GraderResultOutput) {
    return format_result_output({ output: output.output, output_format: output.format as "text" | "markdown" })
}
function format_test_result_name(result: GraderResultTest) {
}

export default function GraderResults() {
    const { submissions_id } = useParams();
    const { query } = useShow<SubmissionWithGraderResults>({
        resource: "submissions",
        id: Number(submissions_id),
        meta: {
            select: "*, assignments(*), grader_results(*), grader_result_tests(*), grader_result_output(*)"
        }
    });
    if (query.isLoading) {
        return <Box>
            <Skeleton height="100px" />
        </Box>
    }
    if (query.error) {
        return <Box>
            Error loading grader results
            {query.error.message}
        </Box>
    }
    if (!query.data) {
        return <Box>
            No grader results found
        </Box>
    }
    const data = query.data.data;
    return (
        <Tabs.Root m={3} defaultValue="tests">
            <Tabs.List>
                <Tabs.Trigger value="tests">Test Results</Tabs.Trigger>
                {data.grader_result_output?.map((output) => (
                    <Tabs.Trigger key={output.id} value={output.visibility}>
                        {data.grader_result_output.length === 1 ? "Output" : output.visibility === "visible" ? "Student Visible Output" : "Instructor-Only Debug Output"}
                    </Tabs.Trigger>
                ))}
            </Tabs.List>
            {data.grader_result_output?.map((output) => (
                <Tabs.Content key={output.id} value={output.visibility}>
                    {format_output(output)}
                </Tabs.Content>
            ))}
            <Tabs.Content value="tests">
                <Heading size="md">Lint Results: {data.grader_results?.lint_passed ? "Passed" : "Failed"}</Heading>
                {data.grader_results?.lint_output && <Box borderWidth="1px" borderRadius="md" p={2}>
                    <Heading size="sm">Lint Output</Heading>
                    {format_result_output({ output: data.grader_results?.lint_output, output_format: data.grader_results?.lint_output_format })}
                </Box>}
                <Heading size="md">Test Results</Heading>
                <Table.Root maxW="2xl">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Name</Table.ColumnHeader>
                            <Table.ColumnHeader>Score</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {data.grader_result_tests[0]?.part &&
                            <Table.Row>
                                <Table.Cell
                                    bg="bg.muted" colSpan={3} fontWeight="bold" textAlign="center">
                                    {data.grader_result_tests[0]?.part}
                                </Table.Cell></Table.Row>}
                        {data.grader_result_tests?.map((result, index) => {
                            const isNewPart = index > 0 && result.part !== data.grader_result_tests[index - 1].part;
                            return <Fragment key={result.id}>
                                {isNewPart && (
                                    <Table.Row>
                                        <Table.Cell colSpan={3}
                                            textAlign="center"
                                            bg="bg.muted" fontWeight="bold">
                                            {result.part}
                                        </Table.Cell>
                                    </Table.Row>
                                )}
                                <Table.Row>
                                    <Table.Cell>{result.score === result.max_score ? "✅" : "❌"}</Table.Cell>
                                    <Table.Cell><Link
                                        variant="underline"
                                        href={`#test-${result.id}`}>{result.name}</Link></Table.Cell>
                                    <Table.Cell>{result.score}/{result.max_score}</Table.Cell>
                                </Table.Row>
                            </Fragment>
                        })}
                    </Table.Body>
                </Table.Root>
                {data.grader_result_tests?.map((result) => (
                    <CardRoot key={result.id} id={`test-${result.id}`} mt={4}>
                        <CardHeader bg="bg.muted" p={2}>
                            <Heading size="lg" color={result.score === result.max_score ? "green" : "red"}>{result.name} ({result.score} / {result.max_score})</Heading>
                        </CardHeader>
                        <CardBody>
                            {format_result_output(result)}
                        </CardBody>
                    </CardRoot>
                ))}
            </Tabs.Content>
        </Tabs.Root>)
}