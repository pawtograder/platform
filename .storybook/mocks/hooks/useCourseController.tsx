export function useCourseController() {
  return {
    classRealTimeController: {
      subscribe: () => () => {},
      unsubscribe: () => {}
    },
    time_zone: "America/New_York"
  } as const;
}

export function useCourse() {
  return { time_zone: "America/New_York" } as const;
}

export function useAssignmentDueDate() {
  return { dueDate: null, hoursExtended: 0, time_zone: "America/New_York" } as const;
}

export function useIsDroppedStudent() {
  return false;
}
