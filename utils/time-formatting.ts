/**
 * Formats a duration in seconds to a human-readable string.
 * @param seconds - The duration in seconds. Can be null or undefined.
 * @returns A formatted string like "1h 30m", "5m 30s", "45s", or "-" for null/undefined.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "-";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Formats a date string to a localized date string.
 * @param dateString - The date string to format.
 * @returns A formatted date string using the locale's date format.
 */
export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString();
}

/**
 * Formats a date string to a localized date and time string.
 * @param dateString - The date string to format.
 * @returns A formatted date and time string using the locale's format.
 */
export function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString();
}
