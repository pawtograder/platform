import { TZDate } from "@date-fns/tz";
import { clsx, type ClassValue } from "clsx";
import { differenceInHours, formatDistance } from "date-fns";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDueDate(date: string | null, courseTimezone?: string) {
  if (!date) {
    return "N/A";
  }
  let advice = "";
  if (courseTimezone && date) {
    const hoursUntilDue = differenceInHours(new TZDate(date), TZDate.tz(courseTimezone));
    if (hoursUntilDue < 36) {
      advice = ` (${formatDistance(new TZDate(date), TZDate.tz(courseTimezone))})`;
    }
  }
  return new Date(date).toLocaleDateString() + " " + new Date(date).toLocaleTimeString() + advice;
}

export function appendTimezoneOffset(date: string | null, timezone: string) {
  if (!date) {
    return date;
  }
  const notTheRightTimeButRightTimezone = new TZDate(date, timezone).toISOString();
  const offset = notTheRightTimeButRightTimezone.substring(notTheRightTimeButRightTimezone.length - 6);
  //If there is already an offset, keep it as is
  if (date.charAt(date.length - 6) === "+" || date.charAt(date.length - 6) === "-") {
    return date;
  }
  return date + offset;
}
