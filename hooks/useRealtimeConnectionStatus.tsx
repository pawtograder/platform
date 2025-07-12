"use client";

import { useState, useEffect } from "react";
import { useCourseController } from "./useCourseController";
import { ConnectionStatus } from "@/lib/ClassRealTimeController";

export function useRealtimeConnectionStatus(): ConnectionStatus | null {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const courseController = useCourseController();
  const classRealTimeController = courseController.classRealTimeController;

  useEffect(() => {
    console.log("Status before subscribing", classRealTimeController.getConnectionStatus());
    setStatus(classRealTimeController.getConnectionStatus());

    const unsubscribe = classRealTimeController.subscribeToStatus((newStatus) => {
      console.log("New statusreceived", newStatus);
      setStatus(newStatus);
    });

    return () => {
      if (unsubscribe) {
        console.log("Unsubscribing from status changes");
        unsubscribe();
      }
    };
  }, [classRealTimeController]);

  return status;
}
