"use client";

import { PostRow } from "@/components/discussion/PostRow";
import type { DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import { subDays } from "date-fns";
import { useMemo } from "react";

export function TopPostsSidebar({
  threads,
  courseId
}: {
  threads: Array<Pick<DiscussionThread, "id" | "likes_count" | "created_at" | "class_id">>;
  courseId: number;
}) {
  const top = useMemo(() => {
    const cutoff = subDays(new Date(), 7);
    return [...threads]
      .filter((t) => new Date(t.created_at) >= cutoff)
      .sort((a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0))
      .slice(0, 5);
  }, [threads]);

  return (
    <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
      <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
        <Heading size="sm">Top Posts This Week</Heading>
      </Box>
      <Stack spaceY="0">
        {top.length === 0 && (
          <Text px="4" py="3" color="fg.muted" fontSize="sm">
            No popular posts yet.
          </Text>
        )}
        {top.map((t) => (
          <PostRow key={t.id} threadId={t.id} href={`/course/${courseId}/discussion/${t.id}`} variant="compact" />
        ))}
      </Stack>
    </Box>
  );
}
