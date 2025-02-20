import { GraderResultOutput, GraderResultTest, SubmissionWithGraderResults } from "@/utils/supabase/DatabaseTypes";
import { Box, CardBody, CardHeader, CardRoot, List, Skeleton, Tabs, Text } from "@chakra-ui/react";
import { useShow } from "@refinedev/core";
import Markdown from "react-markdown";

function format_result_output(result: { output: string | null, output_format: string | null }) {
    if (result.output_format === "text" || result.output_format === null) {
        return <pre>{result.output}</pre>
    }
    if (result.output_format === "markdown") {
        return <Markdown>{result.output}</Markdown>
    }
    return <Text>{result.output}</Text>
}
function format_output(output: GraderResultOutput) {
    return format_result_output({ output: output.output, output_format: output.format as "text" | "markdown" })
}
function format_test_result_name(result: GraderResultTest) {
}

export default function GraderResults({ submission_id }: { submission_id: number }) {
    const { query } = useShow<SubmissionWithGraderResults>({
        resource: "submissions",
        id: submission_id,
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
    return (<Box>
        <Text>Grader Results</Text>
        <Text>Assignment: {data.assignments.title}</Text>
        <Text>Submission: {data.id}</Text>
        <Tabs.Root defaultValue="tests">
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
                Lint: {data.grader_results?.lint_passed ? "Passed" : "Failed"}
                Summary:
                <List.Root>

                    {data.grader_result_tests?.map((result) => (
                        <List.Item key={result.id}>
                            <Text>{result.name} {result.score} / {result.max_score}</Text>
                        </List.Item>
                    ))}
                </List.Root>
                {data.grader_result_tests?.map((result) => (
                    <CardRoot key={result.id}>
                        <CardHeader>
                            <Text>{result.name}</Text>
                            <Text>{result.score} / {result.max_score}</Text>
                        </CardHeader>
                        <CardBody>
                            {format_result_output(result)}
                        </CardBody>
                    </CardRoot>
                ))}
            </Tabs.Content>
        </Tabs.Root >
    </Box>)
}