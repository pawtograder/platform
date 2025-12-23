"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useUnsubscribe } from "@/hooks/useUnsubscribe";

export default function UnsubscribeTopicPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const topicId = Number(params.topic_id);

  const fetchTopicName = async (
    supabase: ReturnType<typeof createClient>,
    entityId: number,
    courseId: number
  ): Promise<string | null> => {
    const { data: topic } = await supabase
      .from("discussion_topics")
      .select("topic")
      .eq("id", entityId)
      .eq("class_id", courseId)
      .single();

    return topic?.topic || null;
  };

  const performTopicUnsubscribe = async (
    supabase: ReturnType<typeof createClient>,
    userId: string,
    entityId: number,
    courseId: number
  ): Promise<void> => {
    // Unfollow the topic by setting following to false
    // First check if a record exists
    const { data: existing, error: queryError } = await supabase
      .from("discussion_topic_followers")
      .select("id, following")
      .eq("user_id", userId)
      .eq("topic_id", entityId)
      .eq("class_id", courseId)
      .maybeSingle();

    // Handle query errors (excluding benign "not found" case)
    if (queryError) {
      // PGRST116 is the "not found" error code, which is benign
      if (queryError.code !== "PGRST116") {
        // This is a real error, throw it so the hook can capture it with Sentry
        throw queryError;
      }
      // If it's PGRST116, treat as null and proceed to insert branch
    }

    if (existing) {
      // Update existing record
      const { error } = await supabase
        .from("discussion_topic_followers")
        .update({ following: false })
        .eq("id", existing.id);

      if (error) {
        throw error;
      }
    } else {
      // Create a record with following=false to override default
      const { error } = await supabase.from("discussion_topic_followers").insert({
        user_id: userId,
        topic_id: entityId,
        class_id: courseId,
        following: false
      });

      if (error) {
        throw error;
      }
    }
  };

  const { status, errorMessage, entityName: topicName } = useUnsubscribe({
    entityType: "topic",
    entityId: topicId,
    courseId,
    fetchName: fetchTopicName,
    performUnsubscribe: performTopicUnsubscribe,
    defaultEntityName: "this topic"
  });

  if (status === "loading") {
    return (
      <Box maxW="600px" mx="auto" mt="50px" p="20px">
        <Heading size="lg" mb="4">
          Unsubscribing...
        </Heading>
        <Text>Please wait while we update your preferences.</Text>
      </Box>
    );
  }

  if (status === "error") {
    return (
      <Box maxW="600px" mx="auto" mt="50px" p="20px">
        <Heading size="lg" mb="4" color="red.600">
          Unsubscribe Error
        </Heading>
        <Box bg="red.50" borderColor="red.200" borderWidth="1px" borderRadius="md" p="15px" mb="4">
          <Text color="red.800">{errorMessage}</Text>
        </Box>
        <Stack direction="row" gap="3">
          <Button asChild>
            <Link href={`/course/${courseId}`}>Return to Course</Link>
          </Button>
        </Stack>
      </Box>
    );
  }

  return (
    <Box maxW="600px" mx="auto" mt="50px" p="20px">
      <Heading size="lg" mb="4">
        ✓ Successfully Unsubscribed
      </Heading>
      <Box bg="green.50" borderColor="green.200" borderWidth="1px" borderRadius="md" p="20px" mb="6">
        <Text fontWeight="semibold" mb="2" color="green.800">
          You have unfollowed &quot;{topicName}&quot;.
        </Text>
        <Text color="green.800">You will no longer receive email notifications for new posts in this topic.</Text>
      </Box>
      <Stack direction="row" gap="3" mb="6">
        <Button asChild>
          <Link href={`/course/${courseId}/discussion`}>View Discussion Board</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/course/${courseId}`}>Return to Course</Link>
        </Button>
      </Stack>
      <Text fontSize="sm" color="fg.muted">
        To manage all your notification preferences, visit your course settings.
      </Text>
    </Box>
  );
}
