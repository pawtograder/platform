"use client";

import { Container } from "@chakra-ui/react";
import PollsHeader from "./PollsHeader";
import EmptyPollsState from "./EmptyPollsState";
import PollsTable from "./PollsTable";
import { useLivePolls } from "@/hooks/useCourseController";
import { useParams } from "next/navigation";

export default function ManagePollsPage() {
  const { course_id } = useParams();
  const courseId = course_id as string;
  const { polls, isLoading } = useLivePolls();

  if (isLoading) {
    return (
      <Container py={8} maxW="1200px" my={2}>
        <PollsHeader courseId={courseId} />
        <div>Loading polls...</div>
      </Container>
    );
  }

  if (polls.length === 0) {
    return <EmptyPollsState courseId={courseId} />;
  }

  return (
    <Container py={8} maxW="1200px" my={2}>
      <PollsHeader courseId={courseId} />
      <PollsTable courseId={courseId} />
    </Container>
  );
}