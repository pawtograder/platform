/* eslint-disable @typescript-eslint/no-explicit-any */
import { classProfiles, profiles } from "./fixtures";
export function useClassProfiles(): any {
  return {
    ...classProfiles,
    role: { role: "grader", public_profile_id: classProfiles.public_profile_id, private_profile_id: classProfiles.private_profile_id },
    allVisibleRoles: Object.values(profiles),
    profiles: Object.values(profiles)
  };
}
export function useIsGraderOrInstructor(): boolean { return true; }
export function useIsInstructor(): boolean { return true; }
export function useIsGrader(): boolean { return false; }
export function useIsStudent(): boolean { return false; }
export function useIsReadOnly(): boolean { return false; }
export function useIsAdmin(): boolean { return false; }
