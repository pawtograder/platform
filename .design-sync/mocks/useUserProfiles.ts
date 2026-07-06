/* eslint-disable @typescript-eslint/no-explicit-any */
import { profiles, STUDENT_ID } from "./fixtures";
export function useUserProfile(uid?: string): any {
  if (uid && profiles[uid]) return profiles[uid];
  return profiles[STUDENT_ID];
}
export function useUserProfiles(): any[] { return Object.values(profiles); }
