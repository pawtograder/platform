import { Container, Heading, Text } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import PollResponsesDynamicViewer from "./PollResponsesDynamicViewer";
import { Database, Json } from "@/utils/supabase/SupabaseTypes";

type PollResponsesPageProps = {
  params: Promise<{ course_id: string; poll_id: string }>;
};

export default async function PollResponsesPage({ params }: PollResponsesPageProps) {
  const { course_id, poll_id } = await params;
  const supabase = await createClient();

  // Fetch poll data
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

  const { data: responsesData, error: responsesError } = await supabase
    .from("live_poll_responses")
    .select("id, live_poll_id, public_profile_id, response, submitted_at, is_submitted, created_at")
    .eq("live_poll_id", poll_id)
    .order("created_at", { ascending: false });

  if (responsesError) {
    console.error("Error fetching poll responses:", responsesError);
    return (
      <Container py={8} maxW="1200px" my={2}>
        <Heading size="xl" mb={4}>
          Poll Analytics
        </Heading>
        <Text>Unable to load poll responses.</Text>
      </Container>
    );
  }

  const responses = responsesData || [];

  const enrichedResponses: Database["public"]["Tables"]["live_poll_responses"]["Row"][] = responses.map(
  (response) => ({
    id: response.id,
    live_poll_id: response.live_poll_id,
    public_profile_id: response.public_profile_id ?? null,
    response: response.response as Json,
    submitted_at: response.submitted_at,
    is_submitted: response.is_submitted ?? false,
    created_at: response.created_at
  })
);

  return (
    <PollResponsesDynamicViewer
      courseId={course_id}
      pollId={poll_id}
      pollQuestion={poll.question}
      pollIsLive={poll.is_live}
      responses={enrichedResponses}
    />
  );
}
