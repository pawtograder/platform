"use client";
import { useTimeZone } from "@/lib/TimeZoneProvider";
import { TZDate } from "@date-fns/tz";
import { formatInTimeZone } from "date-fns-tz";
import { useMemo } from "react";

export function TimeZoneAwareDate({
  date,
  format = "full"
}: {
  date: string | Date | TZDate;
  format?: "full" | "compact" | "dateOnly" | "timeOnly" | "Pp" | "MMM d, h:mm a" | "MMM d";
}) {
  const timeZoneContext = useTimeZone();
  const timeZone = timeZoneContext?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Memoize the formatting to address performance concerns
  const formattedDate = useMemo(() => {
    // Handle different input types
    let d: Date;
    if (date instanceof TZDate || date instanceof Date) {
      d = date; // TZDate extends Date
    } else {
      d = new Date(date); // string
    }

    // Use date-fns for consistent formatting
    switch (format) {
      case "compact":
        // "10/5/2025, 8:21:34 PM EDT"
        return formatInTimeZone(d, timeZone, "M/d/yyyy, h:mm:ss a zzz");

      case "dateOnly":
        // "Oct 5, 2025 (EDT)"
        return formatInTimeZone(d, timeZone, "MMM d, yyyy (zzz)");

      case "timeOnly":
        // "8:21 PM EDT"
        return formatInTimeZone(d, timeZone, "h:mm a zzz");

      case "Pp":
        // "10/05/2025, 8:21 PM EDT"
        return formatInTimeZone(d, timeZone, "MM/dd/yyyy, h:mm a zzz");

      case "MMM d, h:mm a":
        // "Oct 5, 8:21 PM EDT"
        return formatInTimeZone(d, timeZone, "MMM d, h:mm a zzz");

      case "MMM d":
        // "Oct 5 (EDT)"
        return formatInTimeZone(d, timeZone, "MMM d (zzz)");

      default:
      case "full":
        // "Oct 5, 2025, 11:21 PM EDT"
        return formatInTimeZone(d, timeZone, "MMM d, yyyy, h:mm a zzz");
    }
  }, [date, format, timeZone]);

  return <>{formattedDate}</>;
}
