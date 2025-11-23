import { Container } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import PollsHeader from "./PollsHeader";
import EmptyPollsState from "./EmptyPollsState";
import PollsTable from "./PollsTable";
import { LivePoll } from "@/types/poll";

type ManagePollsPageProps = {
  params: Promise<{ course_id: string }>;
};

export type LivePollWithCounts = LivePoll & {
  response_count: number;
};

export default async function ManagePollsPage({ params }: ManagePollsPageProps) {
  const { course_id } = await params;
  const supabase = await createClient();

  const { data: classData } = await supabase.from("classes").select("time_zone").eq("id", Number(course_id)).single();
  const timezone = classData?.time_zone || "America/New_York";

  const { data: pollData, error } = await supabase
    .from("live_polls")
    .select("*")
    .eq("class_id", Number(course_id))
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching polls:", {
      message: error.message
    });
    return <EmptyPollsState courseId={course_id} />;
  }

  const polls = pollData || [];

  if (!polls || polls.length === 0) {
    return <EmptyPollsState courseId={course_id} />;
  }

  const pollsWithCounts = await Promise.all(
    polls.map(async (poll) => {
      const { count } = await supabase
        .from("live_poll_responses")
        .select("*", { count: "exact", head: true })
        .eq("live_poll_id", poll.id);

      return {
        ...poll,
        response_count: count || 0
      };
    })
  );

  return (
    <Container py={8} maxW="1200px" my={2}>
      <PollsHeader courseId={course_id} />
      <PollsTable polls={pollsWithCounts} courseId={course_id} timezone={timezone} />
    </Container>
  );
}

