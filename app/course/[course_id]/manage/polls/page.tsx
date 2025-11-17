import { Container } from "@chakra-ui/react";
import { createClient } from "@/utils/supabase/server";
import PollsHeader from "./PollsHeader";
import EmptyPollsState from "./EmptyPollsState";
import PollsTable from "./PollsTable";

type ManagePollsPageProps = {
  params: Promise<{ course_id: string }>;
};

type LivePollRecord = {
  id: string;
  class_id: number;
  created_by: string;
  title: string;
  question: Record<string, unknown> | null;
  is_live: boolean;
  created_at: string;
};

export type LivePollWithCounts = LivePollRecord & {
  response_count: number;
};

export default async function ManagePollsPage({ params }: ManagePollsPageProps) {
  const { course_id } = await params;
  const supabase = await createClient();

  const { data: classData } = await supabase.from("classes").select("time_zone").eq("id", Number(course_id)).single();
  const timezone = classData?.time_zone || "America/New_York";

  const { data: pollsData, error } = await supabase
    .from("live_polls" as any)
    .select("*")
    .eq("class_id", Number(course_id))
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching polls:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code
    });
  }

  const polls = ((pollsData || []) as unknown) as LivePollRecord[];

  if (!polls || polls.length === 0) {
    return <EmptyPollsState courseId={course_id} />;
  }

  const pollsWithCounts: LivePollWithCounts[] = await Promise.all(
    polls.map(async (poll: LivePollRecord) => {
      const { count } = await supabase
        .from("live_poll_responses" as any)
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

