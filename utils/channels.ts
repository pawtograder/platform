/**
 * A/B deployment channels (see supabase migration add_deployment_channel_to_classes
 * and the chart's `channels` values). Each course is pinned to a channel via
 * classes.deployment_channel; channels run distinct web + edge-functions builds
 * against the SAME database, each served on its own host. Middleware redirects a
 * course to its channel's host so one user can use stable + canary courses in the
 * same session.
 *
 * All routing is gated on NEXT_PUBLIC_CHANNEL_HOST_SUFFIX: when unset (local dev,
 * the hosted supabase.com instance, or a single-channel deployment) channel
 * routing is disabled and behavior is unchanged.
 */

export const STABLE_CHANNEL = "stable";

/** The channel this build was compiled for (baked at image build time). */
export function currentChannel(): string {
  return process.env.NEXT_PUBLIC_PAWTOGRADER_CHANNEL || STABLE_CHANNEL;
}

/**
 * Base host suffix for channel routing, e.g. "staging.pawtograder.net".
 * Returns undefined when channel routing is disabled.
 */
export function channelHostSuffix(): string | undefined {
  return process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX || undefined;
}

/**
 * Public host serving a given channel: the suffix itself for "stable", else
 * "<channel>.<suffix>" — matching the chart's pawtograder.channel.host default.
 * Returns undefined when channel routing is disabled.
 */
export function hostForChannel(channel: string): string | undefined {
  const suffix = channelHostSuffix();
  if (!suffix) return undefined;
  return channel === STABLE_CHANNEL ? suffix : `${channel}.${suffix}`;
}
