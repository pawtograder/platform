"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";

export default function UnsubscribeTopicPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const topicId = Number(params.topic_id);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [topicName, setTopicName] = useState<string>("this topic");

  useEffect(() => {
    async function unsubscribe() {
      if (!Number.isFinite(topicId) || topicId <= 0) {
        setErrorMessage("Invalid topic ID");
        setStatus("error");
        return;
      }

      if (!Number.isFinite(courseId) || courseId <= 0) {
        setErrorMessage("Invalid course ID");
        setStatus("error");
        return;
      }

      const supabase = createClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (!user) {
        setErrorMessage("You must be logged in to unsubscribe. Please log in and try again.");
        setStatus("error");
        return;
      }

      Sentry.setUser({ id: user.id });
      Sentry.setTag("operation", "unsubscribe_topic");
      Sentry.setTag("topic_id", topicId.toString());
      Sentry.setTag("class_id", courseId.toString());

      try {
        // Get topic name first
        const { data: topic } = await supabase
          .from("discussion_topics")
          .select("topic")
          .eq("id", topicId)
          .eq("class_id", courseId)
          .single();

        if (topic) {
          setTopicName(topic.topic || "this topic");
        }

        // Unfollow the topic by setting following to false
        // First check if a record exists
        const { data: existing } = await supabase
          .from("discussion_topic_followers")
          .select("id, following")
          .eq("user_id", user.id)
          .eq("topic_id", topicId)
          .eq("class_id", courseId)
          .single();

        if (existing) {
          // Update existing record
          const { error } = await supabase
            .from("discussion_topic_followers")
            .update({ following: false })
            .eq("id", existing.id);

          if (error) {
            Sentry.captureException(error);
            setErrorMessage("Failed to update follow status. Please try again.");
            setStatus("error");
            return;
          }
        } else {
          // Create a record with following=false to override default
          const { error } = await supabase.from("discussion_topic_followers").insert({
            user_id: user.id,
            topic_id: topicId,
            class_id: courseId,
            following: false
          });

          if (error) {
            Sentry.captureException(error);
            setErrorMessage("Failed to create follow override. Please try again.");
            setStatus("error");
            return;
          }
        }

        setStatus("success");
      } catch (error) {
        Sentry.captureException(error, {
          tags: { operation: "unsubscribe_topic" }
        });
        setErrorMessage("An unexpected error occurred. Please try again later.");
        setStatus("error");
      }
    }

    unsubscribe();
  }, [courseId, topicId]);

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
