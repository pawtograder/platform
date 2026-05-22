"use client";

import { useMemo } from "react";
import {
  filterHelpRequestsForStudentView,
  isDiscussionTeaserVisibleToStudent,
  isDiscussionThreadRowVisibleToStudent,
  isHelpRequestVisibleToStudent,
  studentProfileIdSet,
  type StudentProfileIds
} from "@/lib/viewAsStudentDataMask";
import { useClassProfiles } from "./useClassProfiles";

/**
 * Helpers for masking instructor-only data while viewing the course as a student.
 * When `isMasking` is false, all filters are no-ops.
 */
export function useViewAsStudentDataMask() {
  const { isViewingAsStudent, private_profile_id, public_profile_id } = useClassProfiles();

  const studentIds = useMemo(
    () => studentProfileIdSet(private_profile_id, public_profile_id),
    [private_profile_id, public_profile_id]
  );

  return useMemo(
    () => ({
      isMasking: isViewingAsStudent,
      studentIds,
      filterDiscussionTeaser: <T extends { instructors_only?: boolean | null; author?: string | null }>(thread: T) =>
        !isViewingAsStudent || isDiscussionTeaserVisibleToStudent(thread, studentIds),
      filterDiscussionRow: <T extends { instructors_only?: boolean | null; author?: string | null }>(
        thread: T,
        allRowsInThread?: ReadonlyArray<{ author?: string | null }>
      ) => !isViewingAsStudent || isDiscussionThreadRowVisibleToStudent(thread, studentIds, allRowsInThread),
      filterHelpRequest: <
        T extends { is_private?: boolean | null; created_by?: string | null; assignee?: string | null }
      >(
        request: T,
        memberProfileIds?: ReadonlyArray<string>
      ) => !isViewingAsStudent || isHelpRequestVisibleToStudent(request, studentIds, memberProfileIds),
      filterHelpRequests: <
        T extends {
          id: number;
          is_private?: boolean | null;
          created_by?: string | null;
          assignee?: string | null;
        }
      >(
        requests: T[],
        membersByRequestId: Map<number, string[]>
      ) => (isViewingAsStudent ? filterHelpRequestsForStudentView(requests, studentIds, membersByRequestId) : requests)
    }),
    [isViewingAsStudent, studentIds]
  );
}

export type { StudentProfileIds };
