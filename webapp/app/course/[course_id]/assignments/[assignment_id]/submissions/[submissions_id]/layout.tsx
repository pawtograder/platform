'use client'
import { Button } from "@/components/ui/button";
import {
    PopoverArrow,
    PopoverBody,
    PopoverContent,
    PopoverRoot,
    PopoverTrigger
} from "@/components/ui/popover";
import { SubmissionWithFilesAndComments, SubmissionWithGraderResults } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, HStack, Skeleton, Text } from "@chakra-ui/react";

import Link from "@/components/ui/link";
import { Icon } from "@chakra-ui/react";
import { useList, useShow } from "@refinedev/core";
import { formatRelative } from "date-fns";
import NextLink from "next/link";
import { useParams, usePathname } from "next/navigation";
import { FaFile, FaHistory, FaQuestionCircle, FaRobot } from "react-icons/fa";


export function SubmissionHistory({ submission }: { submission: SubmissionWithFilesAndComments }) {
    const pathname = usePathname();
    const { data, isLoading } = useList<SubmissionWithGraderResults>({
        resource: "submissions",
        meta: {
            select: "*, grader_results(*)"
        },
        filters: [
            {
                field: "assignment_id",
                operator: "eq",
                value: submission.assignments.id
            }
        ],
        sorters: [
            {
                field: "created_at",
                order: "desc"
            }
        ]
    });
    if (isLoading || !submission.assignments) {
        return <Skeleton height="20px" />
    }
    return <PopoverRoot>
        <PopoverTrigger asChild>
            <Button variant="outline">
                <Icon as={FaHistory} />
                Submission History
            </Button>
        </PopoverTrigger>
        <PopoverContent>
            <PopoverArrow />
            <PopoverBody>
                <Text>Submission History</Text>
                {data?.data.map((historical_submission) => (
                    <Link
                        colorPalette={pathname === `/course/${historical_submission.class_id}/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}` ? "teal" : undefined}
                        key={historical_submission.id} href={`/course/${historical_submission.class_id}/assignments/${historical_submission.assignment_id}/submissions/${historical_submission.id}`}>#{historical_submission.ordinal} - {historical_submission.grader_results?.score}/{historical_submission.grader_results?.max_score} ({formatRelative(historical_submission.created_at, new Date())})</Link>
                ))}
            </PopoverBody>
        </PopoverContent>
    </PopoverRoot>
}

export default function SubmissionsLayout({ children }: { children: React.ReactNode }) {
    const { submissions_id } = useParams();
    const pathname = usePathname();
    const { query } = useShow<SubmissionWithFilesAndComments>({
        resource: "submissions",
        id: Number(submissions_id),
        meta: {
            select: "*, assignments(*), submission_files(*, submission_file_comments(*))"
        }
    });
    if (query.isLoading) {
        return <Box>
            <Skeleton height="100px" />
        </Box>
    }
    return <Box borderColor="border.muted"
        borderWidth="2px"
        borderRadius="md"
    >
        <HStack p={4} alignItems="center" justify="space-between" align="center">
            <Box><Heading size="lg">{query.data?.data.assignments.title} - Submission #{query.data?.data.ordinal}</Heading><Link href={`https://github.com/${query.data?.data.repository}/commit/${query.data?.data.sha}`} target="_blank">
                Commit {query.data?.data.sha.substring(0, 7)}
            </Link></Box>
            <HStack>
                <Button variant="surface" onClick={() => {
                    // toaster({
                    //     title: "Ask For Help",
                    //     description: "This feature is not yet implemented.",
                    //     status: "info"
                    // });
                }}>
                    <Icon as={FaQuestionCircle} />
                    Ask For Help
                </Button>
                <SubmissionHistory submission={query.data!.data} />
            </HStack>
        </HStack>
        <Text textStyle="sm" color="text.muted">
        </Text>
        <Box
            p={0}
            m={0}
            borderBottomColor="border.emphasized"
            borderBottomWidth="2px"
            bg="bg.muted"
            defaultValue="results">
            <NextLink prefetch={true} href={`/course/${query.data?.data.class_id}/assignments/${query.data?.data.assignments.id}/submissions/${query.data?.data.id}/results`}>
                <Button variant={pathname.includes("/results") ? "solid" : "ghost"}>
                    <Icon as={FaRobot} />
                    Grading Script Results
                </Button>
            </NextLink>
            <NextLink prefetch={true} href={`/course/${query.data?.data.class_id}/assignments/${query.data?.data.assignments.id}/submissions/${query.data?.data.id}/files`}>
                <Button variant={pathname.includes("/files") ? "solid" : "ghost"}>
                    <Icon as={FaFile} />
                    Files
                </Button>
            </NextLink>
        </Box>
        {children}
    </Box>
}