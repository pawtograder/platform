"use client";
import { HelpRequestWatcher } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useUpdate } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import useAuthState from "./useAuthState";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCourseDataContext } from "./course-data";

function useHelpRequestWatchersQuery() {
  const { courseId, userId, supabase } = useCourseDataContext();
  return useQuery<HelpRequestWatcher[]>({
    queryKey: ["course", courseId, "help_request_watchers", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("help_request_watchers").select("*").eq("user_id", userId);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: Infinity,
    enabled: !!userId
  });
}

export function useHelpRequestWatchStatus(helpRequestId: number) {
  const { data: watchers = [] } = useHelpRequestWatchersQuery();
  const queryClient = useQueryClient();
  const { courseId, userId } = useCourseDataContext();

  const curWatch = useMemo(() => watchers.find((w) => w.help_request_id === helpRequestId), [watchers, helpRequestId]);

  const { mutateAsync: createHelpRequestWatcher } = useCreate({
    resource: "help_request_watchers"
  });

  const { mutateAsync: updateWatch } = useUpdate({
    resource: "help_request_watchers"
  });

  const { user } = useAuthState();
  const { course_id } = useParams();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["course", courseId, "help_request_watchers", userId] });
  }, [queryClient, courseId, userId]);

  const setHelpRequestWatchStatus = useCallback(
    async (status: boolean) => {
      if (curWatch) {
        await updateWatch({
          id: curWatch.id,
          values: {
            enabled: status
          }
        });
      } else {
        await createHelpRequestWatcher({
          values: {
            user_id: user?.id,
            class_id: course_id,
            help_request_id: helpRequestId,
            enabled: status
          }
        });
      }
      invalidate();
    },
    [helpRequestId, curWatch, course_id, user?.id, updateWatch, createHelpRequestWatcher, invalidate]
  );

  return {
    status: curWatch?.enabled ?? false,
    setHelpRequestWatchStatus
  };
}
