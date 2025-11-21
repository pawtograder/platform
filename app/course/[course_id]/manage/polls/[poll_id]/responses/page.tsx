import { Container, Heading, Text } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import { formatInTimeZone } from "date-fns-tz";
import PollResponsesDynamicViewer from "./PollResponsesDynamicViewer";
import PollResponsesHeader from "./PollResponsesHeader";
import { LivePoll, LivePollResponse } from "@/types/poll";

type PollResponsesPageProps = {
  params: Promise<{ course_id: string; poll_id: string }>;
};

export default async function PollResponsesPage({ params }: PollResponsesPageProps) {
  const { course_id, poll_id } = await params;
  const supabase = await createClient();

  // Supabase returns data with unknown structure, so we cast it to our LivePoll type
  // The actual database might have extra fields, but TypeScript will treat it as LivePoll
  const { data: pollData, error: pollError } = await supabase
    .from("live_polls" as any)
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

  const poll = pollData as unknown as LivePoll;

  const { data: responsesData, error: responsesError } = await supabase
    .from("live_poll_responses" as any)
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

  const responses = ((responsesData || []) as unknown) as LivePollResponse[];
  const profileIds = Array.from(new Set(responses.map((response) => response.public_profile_id))).filter(Boolean);

  let profileMap = new Map<string, { name: string | null }>();
  if (profileIds.length > 0) {
    const { data: profilesData } = await supabase
      .from("user_roles" as any)
      .select("public_profile_id, name")
      .in("public_profile_id", profileIds);

    if (profilesData) {
      profileMap = new Map(
        profilesData.map((profile: any) => [
          profile.public_profile_id,
          { name: profile.name || "Unknown" }
        ])
      );
    }
  }

  const enrichedResponses = responses.map((response) => ({
    ...response,
    response: response.response || {},
    profile_name: profileMap.get(response.public_profile_id)?.name || "Unknown"
  }));

  const { data: classData } = await supabase.from("classes").select("time_zone").eq("id", Number(course_id)).single();
  const timezone = classData?.time_zone || "America/New_York";

  return (
    <PollResponsesDynamicViewer
      courseId={course_id}
      pollId={poll_id}
      pollQuestion={poll.question}
      pollIsLive={poll.is_live}
      responses={enrichedResponses}
      timezone={timezone}
    />
  );
}

