"use client";

import { PostRow } from "@/components/discussion/PostRow";
import type { DiscussionThread } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import { useMemo } from "react";

export function PinnedPostsSidebar({
  threads,
  courseId
}: {
  threads: Array<Pick<DiscussionThread, "id" | "pinned" | "created_at" | "class_id">>;
  courseId: number;
}) {
  const pinned = useMemo(() => {
    return [...threads]
      .filter((t) => !!t.pinned)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [threads]);

  return (
    <Box borderWidth="1px" borderColor="border.emphasized" bg="bg.panel" rounded="md" overflow="hidden">
      <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted">
        <Heading size="sm">Pinned Posts</Heading>
      </Box>
      <Stack spaceY="0">
        {pinned.length === 0 && (
          <Text px="4" py="3" color="fg.muted" fontSize="sm">
            No pinned posts.
          </Text>
        )}
        {pinned.map((t) => (
          <PostRow key={t.id} threadId={t.id} href={`/course/${courseId}/discussion/${t.id}`} />
        ))}
      </Stack>
    </Box>
  );
}
