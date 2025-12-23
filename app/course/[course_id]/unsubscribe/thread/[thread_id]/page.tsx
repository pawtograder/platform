"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useUnsubscribe } from "@/hooks/useUnsubscribe";

export default function UnsubscribeThreadPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const threadId = Number(params.thread_id);

  const fetchThreadName = async (
    supabase: ReturnType<typeof createClient>,
    entityId: number,
    courseId: number
  ): Promise<string | null> => {
    const { data: thread } = await supabase
      .from("discussion_threads")
      .select("subject")
      .eq("id", entityId)
      .eq("class_id", courseId)
      .single();

    return thread?.subject || null;
  };

  const performThreadUnsubscribe = async (
    supabase: ReturnType<typeof createClient>,
    userId: string,
    entityId: number,
    courseId: number
  ): Promise<void> => {
    const { data, error } = await supabase
      .from("discussion_thread_watchers")
      .update({ enabled: false })
      .eq("user_id", userId)
      .eq("discussion_thread_root_id", entityId)
      .eq("class_id", courseId)
      .select();

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      const noRowsError = new Error("No matching watch found to unsubscribe");
      (noRowsError as any).code = "NO_ROWS_UPDATED";
      (noRowsError as any).details = {
        user_id: userId,
        discussion_thread_root_id: entityId,
        class_id: courseId
      };
      throw noRowsError;
    }
  };

  const { status, errorMessage, entityName: threadName } = useUnsubscribe({
    entityType: "thread",
    entityId: threadId,
    courseId,
    fetchName: fetchThreadName,
    performUnsubscribe: performThreadUnsubscribe,
    defaultEntityName: "this post"
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
