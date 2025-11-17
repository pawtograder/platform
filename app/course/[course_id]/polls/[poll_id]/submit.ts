import { createClient } from "@/utils/supabase/client";
import { LivePollResponse } from "@/types/poll";

export async function getPollResponse(
  pollId: string,
  publicProfileId: string
): Promise<LivePollResponse | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("live_poll_responses" as any)
    .select("*")
    .eq("live_poll_id", pollId)
    .eq("public_profile_id", publicProfileId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows returned
      return null;
    }
    throw error;
  }

  return (data as unknown) as LivePollResponse;
}

export async function savePollResponse(
  pollId: string,
  publicProfileId: string,
  response: Record<string, unknown>
): Promise<LivePollResponse> {
  const supabase = createClient();

  // Check if response already exists
  const existing = await getPollResponse(pollId, publicProfileId);

  if (existing) {
    // Update existing response
    const { data, error } = await supabase
      .from("live_poll_responses" as any)
      .update({
        response,
        is_submitted: true,
        submitted_at: new Date().toISOString()
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return (data as unknown) as LivePollResponse;
  } else {
    // Create new response
    const { data, error } = await supabase
      .from("live_poll_responses" as any)
      .insert({
        live_poll_id: pollId,
        public_profile_id: publicProfileId,
        response,
        is_submitted: true,
        submitted_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return (data as unknown) as LivePollResponse;
  }
}

