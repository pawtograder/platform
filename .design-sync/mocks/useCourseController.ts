/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockTable } from "./_lib";
import { profiles } from "./fixtures";

const course = { id: 1, name: "CS 3100", slug: "cs3100", term: 202610 };
const courseController: any = {
  profiles: mockTable(Object.values(profiles)),
  assignmentGroupsWithMembers: mockTable([]),
  classSections: mockTable([]),
  labSections: mockTable([]),
  getProfile: (id: string) => profiles[id],
  course,
  isReady: true
};

// ── data-bearing ──
export function useCourseController(): any { return { courseController, role: "grader", course }; }
export function useCourse(): any { return course; }
export function useAssignmentGroupWithMembers(): any { return undefined; }
export function useAssignmentGroupForUser(): any { return undefined; }
export function useAllProfilesForClass(): any[] { return Object.values(profiles); }
export function useAllStudentProfiles(): any[] { return Object.values(profiles); }
export function useGradersAndInstructors(): any[] { return Object.values(profiles); }
export function useProfiles(): any[] { return Object.values(profiles); }
export function useProfileRole(): string { return "grader"; }
export function useClassSections(): any[] { return []; }
export function useLabSections(): any[] { return []; }
export function useLateTokens(): any { return { tokensUsed: 0, tokensAvailable: 0 }; }
export function useAssignmentDueDate(): any { return undefined; }

// ── safe defaults (present so transitive imports resolve; not rendered) ──
export function useActiveLivePolls(): any[] { return []; }
export function useActiveUserRolesWithProfiles(): any[] { return []; }
export function useAllStudentRoles(): any[] { return []; }
export function useAllStudentRoster(): any[] { return []; }
export function useAssignments(): any[] { return []; }
export function useCanShowGradeFor(): boolean { return true; }
export function useDiscordChannel(): any { return undefined; }
export function useDiscordMessage(): any { return undefined; }
export function useDiscussionThreadReadStatus(): any { return undefined; }
export function useDiscussionThreadTeaser(): any { return undefined; }
export function useDiscussionThreadTeasers(): any[] { return []; }
export function useDiscussionTopics(): any[] { return []; }
export function useIsDroppedStudent(): boolean { return false; }
export function useLivePoll(): any { return undefined; }
export function useLivePolls(): any[] { return []; }
export function useObfuscatedGradesMode(): boolean { return false; }
export function useSetObfuscatedGradesMode(): any { return () => {}; }
export function usePollResponseCounts(): any { return {}; }
export function usePrefetchDiscussionThreadOnHover(): any { return () => {}; }
export function usePublishedSurveys(): any[] { return []; }
export function useRootDiscussionThreadReadStatuses(): any[] { return []; }
export function useRosterWithUserInfo(): any[] { return []; }
export function useSetOnlyShowGradesFor(): any { return () => {}; }
export function useStudentDeadlineExtensions(): any[] { return []; }
export function useStudentRoster(): any[] { return []; }
export function useSurvey(): any { return undefined; }
export function useSurveyResponses(): any[] { return []; }
export function useSurveySeries(): any { return undefined; }
export function useSurveysInSeries(): any[] { return []; }
export function useUpdateThreadTeaser(): any { return () => {}; }
export function useUserRolesWithProfiles(): any[] { return []; }
