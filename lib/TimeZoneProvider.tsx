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

export const TimeZoneContext = createContext<TimeZoneContextType | undefined>(undefined);

const STORAGE_KEY = "pawtograder-timezone-pref";

export function TimeZoneProvider({ courseTimeZone, children }: { courseTimeZone: string; children: React.ReactNode }) {
  const [mode, setModeState] = useState<TimeZoneMode>("course");
  const [showModal, setShowModal] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Detect browser time zone (client-only) via state to avoid hydration mismatch
  const [browserTimeZone, setBrowserTimeZone] = useState("UTC");

  useEffect(() => {
    // Client-only: mark as client and detect actual browser timezone once
    setIsClient(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setBrowserTimeZone(tz);
    } catch {
      // noop: keep UTC fallback
    }
  }, []);

  useEffect(() => {
    // Only run preference check once real browser timezone is known on client
    if (!isClient || browserTimeZone === "UTC") return;

    // Check for existing preference in localStorage
    const saved = localStorage.getItem(STORAGE_KEY);
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
      localStorage.setItem(STORAGE_KEY, newMode);
    }
  };

  const dismissModal = () => {
    setShowModal(false);
    // Save the current mode when dismissing (whether user changed it or kept the default)
    if (isClient) {
      localStorage.setItem(STORAGE_KEY, mode);
    }
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
