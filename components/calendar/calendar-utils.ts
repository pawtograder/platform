// Shared color palettes and utilities for calendar components

export interface CalendarColorPalette {
  bg: string;
  bgDark: string;
  border: string;
  accent: string;
  legend: string;
}

// Color palettes for office hours (cool colors) - excludes orange/yellow/red to avoid confusion with events
// Ordered for maximum visual distinction between adjacent indices
export const OFFICE_HOURS_COLORS: CalendarColorPalette[] = [
  { bg: "blue.subtle", bgDark: "blue.muted", border: "blue.500", accent: "blue.600", legend: "blue.500" },
  { bg: "purple.subtle", bgDark: "purple.muted", border: "purple.500", accent: "purple.600", legend: "purple.500" },
  { bg: "teal.subtle", bgDark: "teal.muted", border: "teal.500", accent: "teal.600", legend: "teal.500" },
  { bg: "pink.subtle", bgDark: "pink.muted", border: "pink.500", accent: "pink.600", legend: "pink.500" },
  { bg: "cyan.subtle", bgDark: "cyan.muted", border: "cyan.500", accent: "cyan.600", legend: "cyan.500" },
  { bg: "green.subtle", bgDark: "green.muted", border: "green.500", accent: "green.600", legend: "green.500" },
  { bg: "indigo.subtle", bgDark: "indigo.muted", border: "indigo.500", accent: "indigo.600", legend: "indigo.500" },
  { bg: "violet.subtle", bgDark: "violet.muted", border: "violet.500", accent: "violet.600", legend: "violet.500" }
];

// Color palettes for events (warm colors)
export const EVENTS_COLORS: CalendarColorPalette[] = [
  { bg: "orange.subtle", bgDark: "orange.muted", border: "orange.500", accent: "orange.600", legend: "orange.500" },
  { bg: "yellow.subtle", bgDark: "yellow.muted", border: "yellow.600", accent: "yellow.700", legend: "yellow.600" },
  { bg: "red.subtle", bgDark: "red.muted", border: "red.500", accent: "red.600", legend: "red.500" }
];

/**
 * Check if a string is a valid URL (for virtual meeting links)
 * @param str - The string to check
 * @returns true if the string is a valid HTTP/HTTPS URL
 */
export function isUrl(str: string | null | undefined): boolean {
  if (!str) return false;
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
