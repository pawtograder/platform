'use client';
import { useDiscussionThreadTeasers } from "@/hooks/useCourseController";
import { Box, Container, Heading, VStack } from "@chakra-ui/react";
import { useTable } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { DiscussionThreadTeaser } from "./DiscussionThreadList";


export default function DiscussionPage() {
    const teasers = useDiscussionThreadTeasers();
    const unanswered = useMemo(() => {
        return teasers.filter(teaser => teaser.is_question && !teaser.answer);
    }, [teasers]);
    const answered = useMemo(() => {
        return teasers.filter(teaser => teaser.is_question && teaser.answer);
    }, [teasers]);
    return (<Box>
        <Heading size="md">Unanswered Questions</Heading>
        {unanswered.map(teaser => <DiscussionThreadTeaser key={teaser.id} thread_id={teaser.id}
            width="100%"
        />)}
        <Heading size="md">Answered Questions</Heading>
        {answered.map(teaser => <DiscussionThreadTeaser key={teaser.id} thread_id={teaser.id}
            width="100%"
        />)}
    </Box>
    );
}