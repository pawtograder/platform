export { OfficeHoursDataProvider, useOfficeHoursDataContext } from "./useOfficeHoursDataContext";
export type { OfficeHoursDataContextValue } from "./useOfficeHoursDataContext";
export { OfficeHoursDataBridge } from "./OfficeHoursDataBridge";

// Fixed class-scoped tables (12 hooks)
export { useHelpRequestsQuery } from "./useHelpRequestsQuery";
export { useHelpQueuesQuery } from "./useHelpQueuesQuery";
export { useHelpRequestStudentsQuery } from "./useHelpRequestStudentsQuery";
export { useHelpQueueAssignmentsQuery } from "./useHelpQueueAssignmentsQuery";
export { useStudentKarmaNotesQuery } from "./useStudentKarmaNotesQuery";
export { useHelpRequestTemplatesQuery } from "./useHelpRequestTemplatesQuery";
export { useHelpRequestModerationQuery } from "./useHelpRequestModerationQuery";
export { useStudentHelpActivityQuery } from "./useStudentHelpActivityQuery";
export { useHelpRequestFeedbackQuery } from "./useHelpRequestFeedbackQuery";
export { useHelpRequestFileReferencesQuery } from "./useHelpRequestFileReferencesQuery";
export { useVideoMeetingSessionsQuery } from "./useVideoMeetingSessionsQuery";
export { useHelpRequestWorkSessionsQuery } from "./useHelpRequestWorkSessionsQuery";

// Mutation hooks
export { useHelpRequestWorkSessionDelete } from "./useHelpRequestWorkSessionsMutation";
export { useHelpRequestMessageInsert } from "./useHelpRequestMessageMutations";
export { useHelpRequestReadReceiptInsert } from "./useHelpRequestReadReceiptMutations";

// Dynamic per-request hooks (leak fix -- gcTime auto-evicts after 5 min)
export { useHelpRequestMessagesQuery } from "./useHelpRequestMessagesQuery";
export { useHelpRequestReadReceiptsQuery } from "./useHelpRequestReadReceiptsQuery";
