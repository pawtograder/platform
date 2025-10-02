import { usePostHog } from "posthog-js/react";
import { useCallback } from "react";
import { AnalyticsEventMap, AnalyticsEventName } from "@/types/analytics";

/**
 * Type-safe hook for tracking PostHog events.
 *
 * Usage:
 * ```tsx
 * const trackEvent = useTrackEvent();
 *
 * // TypeScript will enforce correct properties for each event
 * trackEvent('assignment_viewed', {
 *   assignment_id: 123,
 *   course_id: 456,
 *   is_group_assignment: false,
 *   days_until_due: 7,
 *   has_submissions: true,
 *   assignment_slug: 'hw1'
 * });
 * ```
 */
export function useTrackEvent() {
  const posthog = usePostHog();

  const trackEvent = useCallback(
    <T extends AnalyticsEventName>(eventName: T, properties: AnalyticsEventMap[T]) => {
      if (!posthog) {
        // PostHog not initialized (likely missing env var)
        console.debug(`[Analytics] Would track: ${eventName}`, properties);
        return;
      }

      try {
        posthog.capture(eventName, properties as unknown as Record<string, unknown>);
      } catch (error) {
        console.error(`[Analytics] Failed to track ${eventName}:`, error);
      }
    },
    [posthog]
  );

  return trackEvent;
}

/**
 * Helper hook that provides both tracking and course context.
 * Automatically includes common context like user role and course info.
 *
 * Usage:
 * ```tsx
 * const { trackEvent, courseId, posthog } = useTrackEventWithContext();
 *
 * trackEvent('assignment_viewed', {
 *   assignment_id: 123,
 *   course_id: courseId, // Can use the provided courseId
 *   // ... other properties
 * });
 * ```
 */
export function useTrackEventWithContext(courseId?: number) {
  const trackEvent = useTrackEvent();
  const posthog = usePostHog();

  return {
    trackEvent,
    courseId,
    posthog
  };
}
