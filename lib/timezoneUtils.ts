export function getTimeZoneAbbr(tz: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en", {
      timeZone: tz,
      timeZoneName: "short"
    });
    const parts = formatter.formatToParts(now);
    return parts.find((part) => part.type === "timeZoneName")?.value || tz;
  } catch {
    return tz;
  }
}
