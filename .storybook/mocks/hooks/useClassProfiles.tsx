export function useClassProfiles() {
  return {
    private_profile_id: "profile_1",
    role: { role: "instructor" as const }
  };
}

export function useIsGraderOrInstructor() {
  return true;
}

export function useIsInstructor() {
  return true;
}

export function useIsStudent() {
  return false;
}
