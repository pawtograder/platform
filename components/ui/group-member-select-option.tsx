import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useUserProfile } from "@/hooks/useUserProfiles";

/** Label text for a group member in selects and badges (pseudonym + optional real name for staff). */
export function useGroupMemberSelectLabel(profileId: string): string {
  const userProfile = useUserProfile(profileId);
  const isStaff = useIsGraderOrInstructor();
  const displayName = userProfile?.name?.trim() ?? "";
  const realNameSuffix = isStaff && userProfile?.real_name ? ` (${userProfile.real_name})` : "";
  return (displayName || profileId) + realNameSuffix;
}

/** Native `<option>` for picking a group member by private profile id (obfuscation-aware label). */
export function GroupMemberSelectOption({ profileId }: { profileId: string }) {
  const label = useGroupMemberSelectLabel(profileId);
  return <option value={profileId}>{label}</option>;
}

/** Plain text label for badges and inline display (same rules as {@link GroupMemberSelectOption}). */
export function GroupMemberLabelText({ profileId }: { profileId: string }) {
  const label = useGroupMemberSelectLabel(profileId);
  return <>{label}</>;
}
