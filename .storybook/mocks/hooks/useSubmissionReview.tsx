import React, { createContext, useContext } from "react";

const Ctx = createContext({
  activeReviewAssignmentId: undefined as number | undefined,
  activeSubmissionReviewId: 1 as number | undefined,
  activeRubricId: 1 as number | undefined,
  setActiveRubricId: (_id: number | undefined) => {}
});

export function SubmissionReviewProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={{ activeReviewAssignmentId: undefined, activeSubmissionReviewId: 1, activeRubricId: 1, setActiveRubricId: () => {} }}>{children}</Ctx.Provider>;
}

export function useActiveRubricId() {
  const { activeRubricId, setActiveRubricId } = useContext(Ctx);
  return { activeRubricId, setActiveRubricId, scrollToRubricId: undefined, setScrollToRubricId: () => {} } as const;
}

export function useActiveReviewAssignmentId() {
  return undefined;
}

export function useActiveSubmissionReview() {
  return { id: 1, rubric_id: 1, released: true } as any;
}
