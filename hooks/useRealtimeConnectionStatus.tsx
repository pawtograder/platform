"use client";

import { useState, useEffect } from "react";
import { useCourseController } from "./useCourseController";
import { ConnectionStatus } from "@/lib/ClassRealTimeController";

export function useRealtimeConnectionStatus(): ConnectionStatus | null {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const courseController = useCourseController();
  const classRealTimeController = courseController.classRealTimeController;

  useEffect(() => {
    setStatus(classRealTimeController.getConnectionStatus());

    const unsubscribe = classRealTimeController.subscribeToStatus((newStatus) => {
      setStatus(newStatus);
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [classRealTimeController]);

  return status;
}
