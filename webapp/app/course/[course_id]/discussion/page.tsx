'use client';
import { DiscussionThreadWithAuthorAndTopic } from "@/utils/supabase/DatabaseTypes";
import { Container } from "@chakra-ui/react";
import { useTable } from "@refinedev/core";
import { useParams } from "next/navigation";


export default function DiscussionPage() {

    return (
        <Container maxW="4xl" py={{ base: '2', md: '4' }}>
           (Dashboard goes here, pick a thread from the left)
        </Container>
    );
}