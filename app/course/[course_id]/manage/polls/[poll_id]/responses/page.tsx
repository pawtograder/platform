import { Container, Heading, Text } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import PollResponsesDynamicViewer from "./PollResponsesDynamicViewer";

type PollResponsesPageProps = {
  params: Promise<{ course_id: string; poll_id: string }>;
};

export default async function PollResponsesPage({ params }: PollResponsesPageProps) {
  const { course_id, poll_id } = await params;
  const supabase = await createClient();

  // Fetch poll data for initial render (question structure)
  const { data: pollData, error: pollError } = await supabase
    .from("live_polls")
    .select("*")
    .eq("id", poll_id)
    .eq("class_id", Number(course_id))
    .single();

  if (pollError || !pollData) {
    console.error("Error fetching poll:", pollError);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Poll Analytics
        </Heading>
        <Text>Unable to load poll details.</Text>
      </Container>
    );
  }

  const poll = pollData;
  if (!poll) {
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Poll Analytics
        </Heading>
        <Text>Unable to load poll details.</Text>
      </Container>
    );
  }

  // Pass poll data to client component
  return (
    <PollResponsesDynamicViewer
      courseId={course_id}
      pollId={poll_id}
      pollQuestion={poll.question}
      pollIsLive={poll.is_live}
    />
  );
}
