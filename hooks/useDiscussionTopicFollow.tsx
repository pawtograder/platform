"use client";

import { toaster } from "@/components/ui/toaster";
import { useFindTableControllerValue, useTableControllerTableValues } from "@/lib/TableController";
import type { DiscussionTopicFollower } from "@/utils/supabase/DatabaseTypes";
import { useCallback, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useCourseController, useDiscussionTopics } from "./useCourseController";

export function useDiscussionTopicFollowStatus(topicId: number) {
  const controller = useCourseController();
  const { user } = useAuthState();
  const topics = useDiscussionTopics();

  const topic = useMemo(() => topics?.find((t) => t.id === topicId), [topics, topicId]);

  const predicate = useMemo(
    () => (row: DiscussionTopicFollower) => row.topic_id === topicId && row.user_id === user?.id,
    [topicId, user?.id]
  );

  const cur = useFindTableControllerValue(controller.discussionTopicFollowers, predicate);

  const status = useMemo(() => {
    if (cur) return !!cur.following;
    return !!topic?.default_follow;
  }, [cur, topic?.default_follow]);

  const setTopicFollowStatus = useCallback(
    async (next: boolean) => {
      if (!user?.id) {
        toaster.error({
          title: "Error",
          description: "You must be logged in to follow topics"
        });
        return;
      }
      if (!topic) {
        return;
      }

      try {
        const defaultState = !!topic.default_follow;

        // If the requested state equals the default, store no override row.
        if (next === defaultState) {
          if (cur) {
            await controller.discussionTopicFollowers.hardDelete(cur.id);
          }
          return;
        }

        // Otherwise, store/update an explicit override.
        if (cur) {
          await controller.discussionTopicFollowers.update(cur.id, { following: next });
        } else {
          await controller.discussionTopicFollowers.create({
            user_id: user.id,
            class_id: controller.courseId,
            topic_id: topicId,
            following: next
          });
        }
      } catch (error) {
        toaster.error({
          title: "Error updating topic follow",
          description: "Please try again later"
        });
        // eslint-disable-next-line no-console
        console.error("Failed to update topic follow:", error);
      }
    },
    [controller.courseId, controller.discussionTopicFollowers, cur, topic, topicId, user?.id]
  );

  return { topic, status, setTopicFollowStatus, override: cur ?? null };
}

/**
 * Returns a stable set of topic IDs the user is effectively following.
 *
 * Semantics:
 * - If a topic has default_follow=true, the user follows unless they have an override row with following=false.
 * - If default_follow=false, the user follows only if they have an override row with following=true.
 */
export function useFollowedDiscussionTopicIds() {
  const controller = useCourseController();
  const topics = useDiscussionTopics();
  const rows = useTableControllerTableValues(controller.discussionTopicFollowers) ?? [];

  return useMemo(() => {
    const set = new Set<number>();

    for (const t of topics ?? []) {
      if (t.default_follow) set.add(t.id);
    }

    for (const row of rows) {
      if (row.following) set.add(row.topic_id);
      else set.delete(row.topic_id);
    }

    return set;
  }, [rows, topics]);
}

/**
 * Bulk-friendly follow/unfollow actions (avoid per-topic hook instances).
 */
export function useTopicFollowActions() {
  const controller = useCourseController();
  const { user } = useAuthState();
  const topics = useDiscussionTopics();
  const rows = useTableControllerTableValues(controller.discussionTopicFollowers);

  const topicById = useMemo(() => {
    const map = new Map<number, (typeof topics)[number]>();
    for (const t of topics ?? []) map.set(t.id, t);
    return map;
  }, [topics]);

  const overrideByTopicId = useMemo(() => {
    if (!rows) return new Map<number, DiscussionTopicFollower>();
    const map = new Map<number, DiscussionTopicFollower>();
    for (const r of rows) map.set(r.topic_id, r);
    return map;
  }, [rows]);

  const setTopicFollowStatusForId = useCallback(
    async (topicId: number, next: boolean) => {
      if (!user?.id) {
        toaster.error({
          title: "Error",
          description: "You must be logged in to follow topics"
        });
        return;
      }

      const topic = topicById.get(topicId);
      if (!topic) return;

      const cur = overrideByTopicId.get(topicId);

      try {
        const defaultState = !!topic.default_follow;

        // If the requested state equals the default, store no override row.
        if (next === defaultState) {
          if (cur) await controller.discussionTopicFollowers.hardDelete(cur.id);
          return;
        }

        // Otherwise, store/update an explicit override.
        if (cur) {
          await controller.discussionTopicFollowers.update(cur.id, { following: next });
        } else {
          await controller.discussionTopicFollowers.create({
            user_id: user.id,
            class_id: controller.courseId,
            topic_id: topicId,
            following: next
          });
        }
      } catch (error) {
        toaster.error({
          title: "Error updating topic follow",
          description: "Please try again later"
        });
        // eslint-disable-next-line no-console
        console.error("Failed to update topic follow:", error);
      }
    },
    [controller.courseId, controller.discussionTopicFollowers, overrideByTopicId, topicById, user?.id]
  );

  return { setTopicFollowStatusForId };
}
