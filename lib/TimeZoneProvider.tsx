"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export type TimeZoneMode = "course" | "browser";

interface TimeZoneContextType {
  mode: TimeZoneMode;
  setMode: (mode: TimeZoneMode) => void;
  timeZone: string;
  courseTimeZone: string;
  browserTimeZone: string;
  showModal: boolean;
  dismissModal: () => void;
  openModal: () => void;
}

const TimeZoneContext = createContext<TimeZoneContextType | undefined>(undefined);

const COOKIE_NAME = "pawtograder-timezone-pref";

export function TimeZoneProvider({ courseTimeZone, children }: { courseTimeZone: string; children: React.ReactNode }) {
  const [mode, setModeState] = useState<TimeZoneMode>("course");
  const [showModal, setShowModal] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Detect browser time zone (only on client)
  const browserTimeZone = isClient ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;

    // Check for existing preference in localStorage
    const saved = localStorage.getItem(COOKIE_NAME);
    if (saved === "course" || saved === "browser") {
      setModeState(saved);
    } else if (browserTimeZone !== courseTimeZone) {
      // Only show modal if timezones differ and no preference is saved
      setShowModal(true);
    }
  }, [courseTimeZone, browserTimeZone, isClient]);

  const setMode = (newMode: TimeZoneMode) => {
    setModeState(newMode);
    if (isClient) {
      localStorage.setItem(COOKIE_NAME, newMode);
    }
  };

  const dismissModal = () => {
    setShowModal(false);
    // Don't reset the mode - let the user's selection (if any) persist
  };

  const openModal = () => {
    setShowModal(true);
  };

  // Get the active timezone based on current mode
  const activeTimeZone = mode === "course" ? courseTimeZone : browserTimeZone;

  return (
    <TimeZoneContext.Provider
      value={{
        mode,
        setMode,
        timeZone: activeTimeZone,
        courseTimeZone,
        browserTimeZone,
        showModal,
        dismissModal,
        openModal
      }}
    >
      {children}
    </TimeZoneContext.Provider>
  );
}

export function useTimeZone() {
  const context = useContext(TimeZoneContext);
  if (!context) {
    throw new Error("useTimeZone must be used within a TimeZoneProvider");
  }
  return context;
}
