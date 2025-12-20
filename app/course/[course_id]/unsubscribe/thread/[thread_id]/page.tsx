"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";

export default function UnsubscribeThreadPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const threadId = Number(params.thread_id);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [threadName, setThreadName] = useState<string>("this post");

  useEffect(() => {
    async function unsubscribe() {
      if (!Number.isFinite(threadId) || threadId <= 0) {
        setErrorMessage("Invalid thread ID");
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
      Sentry.setTag("operation", "unsubscribe_thread");
      Sentry.setTag("thread_id", threadId.toString());
      Sentry.setTag("class_id", courseId.toString());

      try {
        // Get thread subject first
        const { data: thread } = await supabase
          .from("discussion_threads")
          .select("subject")
          .eq("id", threadId)
          .eq("class_id", courseId)
          .single();

        if (thread) {
          setThreadName(thread.subject || "this post");
        }

        // Disable the thread watch
        const { error } = await supabase
          .from("discussion_thread_watchers")
          .update({ enabled: false })
          .eq("user_id", user.id)
          .eq("discussion_thread_root_id", threadId)
          .eq("class_id", courseId);

        if (error) {
          Sentry.captureException(error);
          setErrorMessage("Failed to update watch status. Please try again.");
          setStatus("error");
          return;
        }

        setStatus("success");
      } catch (error) {
        Sentry.captureException(error, {
          tags: { operation: "unsubscribe_thread" }
        });
        setErrorMessage("An unexpected error occurred. Please try again later.");
        setStatus("error");
      }
    }

    unsubscribe();
  }, [courseId, threadId]);

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
          You have unfollowed &quot;{threadName}&quot;.
        </Text>
        <Text color="green.800">You will no longer receive email notifications for replies to this post.</Text>
      </Box>
      <Stack direction="row" gap="3" mb="6">
        <Button asChild>
          <Link href={`/course/${courseId}/discussion/${threadId}`}>View Post</Link>
        </Button>
        <Button variant="outline" asChild>
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
