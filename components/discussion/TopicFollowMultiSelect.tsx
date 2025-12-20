"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";
import type { DiscussionTopic } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { useMemo, useState } from "react";

export function TopicFollowMultiSelect({
  topics,
  followedTopicIds,
  onSetTopicFollowStatusAction
}: {
  topics: DiscussionTopic[];
  followedTopicIds: Set<number>;
  onSetTopicFollowStatusAction: (topicId: number, next: boolean) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");

  const filteredTopics = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return topics;
    return topics.filter((t) => (t.topic ?? "").toLowerCase().includes(q));
  }, [query, topics]);

  const followedCount = useMemo(() => {
    let c = 0;
    for (const t of topics) if (followedTopicIds.has(t.id)) c += 1;
    return c;
  }, [followedTopicIds, topics]);

  return (
    <PopoverRoot positioning={{ placement: "bottom-end" }} lazyMount>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Followed topics ({followedCount})
        </Button>
      </PopoverTrigger>
      <PopoverContent width="sm" p="3">
        <PopoverBody>
          <Stack spaceY="3">
            <Text fontSize="xs" color="fg.muted">
              Following a topic notifies you of new posts in that topic (not replies to existing posts). You can manage
              notification preferences in your settings.
            </Text>
            <Input size="sm" placeholder="Filter topics…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Box maxH="320px" overflowY="auto" pr="1">
              <Stack spaceY="2">
                {filteredTopics.map((t) => {
                  const checked = followedTopicIds.has(t.id);
                  return (
                    <HStack key={t.id} justify="space-between" gap="3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(details) => onSetTopicFollowStatusAction(t.id, details.checked === true)}
                      >
                        <Text fontSize="sm">{t.topic}</Text>
                      </Checkbox>
                    </HStack>
                  );
                })}
                {filteredTopics.length === 0 && (
                  <Text fontSize="sm" color="fg.muted">
                    No topics match.
                  </Text>
                )}
              </Stack>
            </Box>
          </Stack>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
