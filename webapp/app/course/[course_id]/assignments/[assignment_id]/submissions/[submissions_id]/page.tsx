'use client';

import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import SyntaxHighlighter, { createElement } from 'react-syntax-highlighter';
import { docco } from 'react-syntax-highlighter/dist/esm/styles/hljs';

type SubmissionFiles = Database['public']['Tables']['submission_files']['Row'];

function LineComments({
    line,
    submission
}: {
    line: number,
    submission: Database['public']['Tables']['submissions']['Row'] | undefined
}) {
    if (!submission) {
        return null;
    }
    return <Box>
        {/* {submission.line_comments.filter((comment) => comment.line === line).map((comment) => ( */}
            <div>comment</div>
        {/* ))} */}
    </Box>
}
export default function SubmissionsView() {
    const { course_id, assignment_id, submissions_id } = useParams();
    const [files, setFiles] = useState<SubmissionFiles[]>([]);
    const [assignment, setAssignment] = useState<Database['public']['Tables']['assignments']['Row'] | undefined>();
    const [submission, setSubmission] = useState<Database['public']['Tables']['submissions']['Row'] | undefined>();
    const [curFile, setCurFile] = useState<SubmissionFiles | undefined>();

    useEffect(() => {
        async function loadSubmission() {
            const client = createClient();
            const { error, data: submission } = await client.from("submissions").select("*, assignments(*), submission_files(*)").eq("id", submissions_id).single();
            if (error) {
                console.error(error);
            }
            setSubmission(submission);
            setAssignment(submission.assignments);
            setCurFile(submission.submission_files[0]);
            setFiles(submission.submission_files);
        }
        loadSubmission();
    }, [course_id, assignment_id, submissions_id]);
    const renderer = useCallback(({
        rows, stylesheet, useInlineStyles }: rendererProps) => (
        <div style={{ height: '100%' }}>
            {rows.map((row, i) => (
                <div key={i} onMouseEnter={() => console.log(i)}>
                    {createElement({ node: row, stylesheet, useInlineStyles, key: i })}
                    <LineComments line={i} submission={submission} />
                </div>
            ))
            }
        </div>), []);
    if (!submission || !assignment) {
        return <div>Submission not found</div>
    }

    return <div>
        <h1>Submission for {assignment.title}</h1>
        <HStack>
            <Box>
                <h2>Files</h2>
                <ul>
                    {files.map((file) => (
                        <li key={file.id} onClick={() => setCurFile(file)}>{file.name}</li>
                    ))}
                </ul>
            </Box>
            <Box>
                <h2>Current File</h2>
                <SyntaxHighlighter showLineNumbers={true}
                    wrapLines={true}
                    renderer={renderer}
                    language='js' style={docco}>
                    {curFile?.contents || ''}
                </SyntaxHighlighter>
            </Box>
        </HStack>

    </div>
}
