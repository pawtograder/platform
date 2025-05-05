'use client';

import SubmissionsLayoutWrapper from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/layout";
import Link from "@/components/ui/link";
import { Box, Heading } from "@chakra-ui/react";
import { useParams } from "next/navigation";

export default function GradeLayout({ children }: { children: React.ReactNode }) {
    const {course_id, assignment_id, submissions_id} = useParams();
    return <Box>
            <SubmissionsLayoutWrapper>{children}</SubmissionsLayoutWrapper>
        <Box w="100%" bg="bg.muted" p={2} borderRadius="md" position="sticky" bottom={0} left={0} right={0}>
            <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/submissions`}>View All Student Submissions</Link>
        </Box>
    </Box>
}