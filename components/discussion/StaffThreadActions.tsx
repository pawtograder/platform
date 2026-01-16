"use client";

import { Field } from "@/components/ui/field";
import { SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValueText } from "@/components/ui/select";
import { toaster } from "@/components/ui/toaster";
import { useCourseController, useDiscussionTopics } from "@/hooks/useCourseController";
import { DiscussionThread as DiscussionThreadType } from "@/utils/supabase/DatabaseTypes";
import { createListCollection } from "@chakra-ui/react";
import { useCallback, useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";

interface StaffThreadActionsProps {
  thread: DiscussionThreadType;
  onUpdateAction: () => void;
}

export function StaffThreadActions({ thread, onUpdateAction }: StaffThreadActionsProps) {
  const { discussionThreadTeasers } = useCourseController();
  const topics = useDiscussionTopics();
  const [isUpdatingTopic, setIsUpdatingTopic] = useState(false);
  const supabase = useMemo(() => createClient(), []);

  const handleTopicChange = useCallback(
    async (newTopicId: string) => {
      if (!newTopicId || Number(newTopicId) === thread.topic_id) {
        return;
      }

      setIsUpdatingTopic(true);
      try {
        const newTopicIdNum = Number(newTopicId);

        // Update the root thread
        await discussionThreadTeasers.update(thread.id, {
          topic_id: newTopicIdNum
        });

        // Update all child threads (replies) to match the root topic
        const { error: childrenError } = await supabase
          .from("discussion_threads")
          .update({ topic_id: newTopicIdNum })
          .eq("root", thread.id)
          .neq("id", thread.id); // Don't update the root thread again

        if (childrenError) {
          throw childrenError;
        }

        toaster.success({
          title: "Success",
          description: "Topic updated for this post and all replies"
        });
        onUpdateAction();
      } catch (error) {
        toaster.error({
          title: "Error",
          description: `Failed to update topic: ${error instanceof Error ? error.message : String(error)}`
        });
      } finally {
        setIsUpdatingTopic(false);
      }
    },
    [thread.id, thread.topic_id, discussionThreadTeasers, supabase, onUpdateAction]
  );

  // Sort topics for display
  const sortedTopics = useMemo(() => {
    if (!topics) return [];
    return [...topics].sort((a, b) => {
      // General topics first (no assignment_id), then assignment-linked topics
      if (!a.assignment_id && b.assignment_id) return -1;
      if (a.assignment_id && !b.assignment_id) return 1;
      // Within each group, sort by ordinal
      return a.ordinal - b.ordinal;
    });
  }, [topics]);

  // Create collection for Select component
  const topicsCollection = useMemo(() => {
    return createListCollection({
      items: sortedTopics,
      itemToString: (topic) => topic.topic,
      itemToValue: (topic) => topic.id.toString()
    });
  }, [sortedTopics]);

  return (
    <Field label="Topic" helperText="Change the topic category for this post">
      <SelectRoot
        collection={topicsCollection}
        value={[thread.topic_id.toString()]}
        onValueChange={(details) => {
          const newValue = details.value[0];
          if (newValue) {
            handleTopicChange(newValue);
          }
        }}
        disabled={isUpdatingTopic}
        size="sm"
      >
        <SelectTrigger>
          <SelectValueText placeholder="Select a topic..." />
        </SelectTrigger>
        <SelectContent>
          {sortedTopics.map((topic) => (
            <SelectItem key={topic.id} item={topic}>
              {topic.topic}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
    </Field>
  );
}
