"use client";
import { useTimeZone } from "@/lib/TimeZoneProvider";

export function TimeZoneAwareDate({
  date,
  format = "full"
}: {
  date: string;
  format?: "full" | "compact" | "dateOnly" | "timeOnly" | "Pp" | "MMM d, h:mm a" | "MMM d";
}) {
  // Always call hook unconditionally at top level (Rules of Hooks)
  const timeZoneContext = useTimeZone();

  // Use provider timezone if available, otherwise fall back to browser's timezone
  const timeZone = timeZoneContext?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const d = new Date(date);

  // Helper to safely extract timezone abbreviation
  const getTimeZoneAbbr = () => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone,
        timeZoneName: "short"
      }).formatToParts(d);
      return parts.find((part) => part.type === "timeZoneName")?.value || "";
    } catch {
      // Fallback to the original method if formatToParts fails
      return d.toLocaleString("en-US", { timeZone: timeZone, timeZoneName: "short" }).split(", ")[1] || "";
    }
  };

  // Handle different format options
  switch (format) {
    case "compact":
      // "10/5/2025, 8:21:34 PM EDT"
      return (
        <>
          {d.toLocaleString("en-US", {
            timeZone: timeZone,
            month: "numeric",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short"
          })}
        </>
      );
    case "dateOnly":
      // "Oct 5, 2025 (EDT)"
      return (
        <>
          {d.toLocaleDateString("en-US", {
            timeZone: timeZone,
            month: "short",
            day: "numeric",
            year: "numeric"
          })}{" "}
          ({getTimeZoneAbbr()})
        </>
      );
    case "timeOnly":
      // "8:21 PM EDT"
      return (
        <>
          {d.toLocaleTimeString("en-US", {
            timeZone: timeZone,
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          })}
        </>
      );
    case "Pp":
      // "10/05/2025, 8:21 PM"
      return (
        <>
          {d.toLocaleString("en-US", {
            timeZone: timeZone,
            month: "2-digit",
            day: "2-digit",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          })}
        </>
      );
    case "MMM d, h:mm a":
      // "Oct 5, 8:21 PM EDT"
      return (
        <>
          {d.toLocaleString("en-US", {
            timeZone: timeZone,
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          })}
        </>
      );
    case "MMM d":
      // "Oct 5 (EDT)"
      return (
        <>
          {d.toLocaleDateString("en-US", {
            timeZone: timeZone,
            month: "short",
            day: "numeric"
          })}{" "}
          ({getTimeZoneAbbr()})
        </>
      );
    default:
    case "full":
      // "Oct 5, 2025, 11:21 PM EDT"
      return (
        <>
          {d.toLocaleString("en-US", {
            timeZone: timeZone,
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          })}
        </>
      );
  }
}
