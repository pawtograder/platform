export { CourseDataProvider, useCourseDataContext } from "./useCourseDataContext";
export type { CourseDataContextValue } from "./useCourseDataContext";
export { CourseDataBridge } from "./CourseDataBridge";
export { useProfilesQuery } from "./useProfilesQuery";
export { useTagsQuery } from "./useTagsQuery";
export { useAssignmentsQuery } from "./useAssignmentsQuery";
export { useDiscussionTopicsQuery } from "./useDiscussionTopicsQuery";
export { useNotificationsQuery } from "./useNotificationsQuery";
export { useRepositoriesQuery } from "./useRepositoriesQuery";
export { useGradebookColumnsQuery } from "./useGradebookColumnsQuery";
export { useDiscussionThreadReadStatusQuery } from "./useDiscussionThreadReadStatusQuery";
export { useDiscussionThreadWatchersQuery } from "./useDiscussionThreadWatchersQuery";
export { useDiscussionTopicFollowersQuery } from "./useDiscussionTopicFollowersQuery";
export { useDiscussionThreadLikesQuery } from "./useDiscussionThreadLikesQuery";
export { useStudentDeadlineExtensionsQuery } from "./useStudentDeadlineExtensionsQuery";
export { useAssignmentDueDateExceptionsQuery } from "./useAssignmentDueDateExceptionsQuery";
export { useUserRolesQuery } from "./useUserRolesQuery";
export type { UserRoleWithPrivateProfileAndUser } from "./useUserRolesQuery";
export { useAssignmentGroupsQuery } from "./useAssignmentGroupsQuery";
export type { AssignmentGroupWithMembers } from "./useAssignmentGroupsQuery";

// Phase 3 Batch 4 — lab sections, class sections
export { useLabSectionsQuery } from "./useLabSectionsQuery";
export { useLabSectionMeetingsQuery } from "./useLabSectionMeetingsQuery";
export { useLabSectionLeadersQuery } from "./useLabSectionLeadersQuery";
export { useClassSectionsQuery } from "./useClassSectionsQuery";
export { useLabSectionInsert, useLabSectionUpdate, useLabSectionDelete } from "./useLabSectionsMutation";
export {
  useLabSectionMeetingInsert,
  useLabSectionMeetingUpdate,
  useLabSectionMeetingDelete
} from "./useLabSectionMeetingsMutation";
export {
  useLabSectionLeaderInsert,
  useLabSectionLeaderUpdate,
  useLabSectionLeaderDelete
} from "./useLabSectionLeadersMutation";

// Phase 3 Batch 6 — discussion thread teasers
export { useDiscussionThreadTeasersQuery } from "./useDiscussionThreadTeasersQuery";

// Phase 3 — discussion mutation hooks
export {
  useDiscussionTopicFollowerInsert,
  useDiscussionTopicFollowerUpdate,
  useDiscussionTopicFollowerDelete
} from "./useDiscussionTopicFollowersMutation";
export {
  useDiscussionThreadWatcherInsert,
  useDiscussionThreadWatcherUpdate
} from "./useDiscussionThreadWatchersMutation";
export {
  useDiscussionTopicInsert,
  useDiscussionTopicUpdate,
  useDiscussionTopicDelete
} from "./useDiscussionTopicsMutation";
export { useDiscussionThreadTeaserUpdate } from "./useDiscussionThreadTeasersMutation";
export { useDiscussionThreadReadStatusUpdate } from "./useDiscussionThreadReadStatusMutation";

// Phase 3 — assignment due date exception mutation hooks
export {
  useAssignmentDueDateExceptionInsert,
  useAssignmentDueDateExceptionDelete
} from "./useAssignmentDueDateExceptionsMutation";

// Phase 3 — survey mutation hooks
export { useSurveyUpdate } from "./useSurveysMutation";

// Phase 3 Batch 5 — calendar, staff settings, discord, polls, surveys
export { useCalendarEventsQuery } from "./useCalendarEventsQuery";
export { useClassStaffSettingsQuery } from "./useClassStaffSettingsQuery";
export { useDiscordChannelsQuery } from "./useDiscordChannelsQuery";
export { useDiscordMessagesQuery } from "./useDiscordMessagesQuery";
export { useLivePollsQuery } from "./useLivePollsQuery";
export { useSurveysQuery } from "./useSurveysQuery";
export { useSurveySeriesQuery } from "./useSurveySeriesQuery";
