import {
  channelHostSuffix,
  currentChannel,
  hostForChannel,
  sessionCookieOptions,
  STABLE_CHANNEL
} from "@/utils/channels";

/**
 * A/B deployment-channel routing primitives (utils/channels.ts) are the single
 * source of truth the web middleware and the Helm chart must agree on:
 *  - hostForChannel() must produce exactly "<channel>.<suffix>" (the chart pins
 *    every channel to that fixed host; there is no per-channel host override).
 *  - sessionCookieOptions() must DERIVE the cross-channel cookie domain from the
 *    suffix, so the redirect and the cookie scope can never be half-configured.
 * These read process.env at call time, so we mutate it per test.
 */
describe("utils/channels", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NEXT_PUBLIC_PAWTOGRADER_CHANNEL;
    delete process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("currentChannel", () => {
    it("defaults to stable when unset", () => {
      expect(currentChannel()).toBe(STABLE_CHANNEL);
      expect(STABLE_CHANNEL).toBe("stable");
    });

    it("reflects the baked channel", () => {
      process.env.NEXT_PUBLIC_PAWTOGRADER_CHANNEL = "team7";
      expect(currentChannel()).toBe("team7");
    });
  });

  describe("channelHostSuffix", () => {
    it("is undefined when routing is disabled", () => {
      expect(channelHostSuffix()).toBeUndefined();
    });

    it("treats an empty string as disabled (not a zero-length zone)", () => {
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "";
      expect(channelHostSuffix()).toBeUndefined();
    });

    it("returns the configured suffix", () => {
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "staging.pawtograder.net";
      expect(channelHostSuffix()).toBe("staging.pawtograder.net");
    });
  });

  describe("hostForChannel", () => {
    it("returns undefined when routing is disabled (no extra work / no redirect)", () => {
      expect(hostForChannel("team7")).toBeUndefined();
      expect(hostForChannel(STABLE_CHANNEL)).toBeUndefined();
    });

    it("serves stable on the bare suffix host", () => {
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "staging.pawtograder.net";
      expect(hostForChannel(STABLE_CHANNEL)).toBe("staging.pawtograder.net");
    });

    it("serves a channel on the fixed <channel>.<suffix> host the chart renders", () => {
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "staging.pawtograder.net";
      // Must match charts/.../_helpers.tpl pawtograder.channel.host exactly.
      expect(hostForChannel("team7")).toBe("team7.staging.pawtograder.net");
    });
  });

  describe("sessionCookieOptions", () => {
    it("is a no-op (host-only cookies) when routing is disabled", () => {
      expect(sessionCookieOptions()).toEqual({});
    });

    it("derives the parent-zone cookie domain from the suffix when routing is enabled", () => {
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "staging.pawtograder.net";
      expect(sessionCookieOptions()).toEqual({
        cookieOptions: { domain: ".staging.pawtograder.net" }
      });
    });

    it("scopes the cookie to the same zone the channel hosts live under", () => {
      // The derived domain must be a parent of both the stable host and every
      // <channel>.<suffix> host, or a cross-host redirect drops the session.
      process.env.NEXT_PUBLIC_CHANNEL_HOST_SUFFIX = "staging.pawtograder.net";
      const opts = sessionCookieOptions() as { cookieOptions: { domain: string } };
      const channelHost = hostForChannel("team7")!;
      const stableHost = hostForChannel(STABLE_CHANNEL)!;
      expect(channelHost.endsWith(opts.cookieOptions.domain.slice(1))).toBe(true);
      expect(stableHost.endsWith(opts.cookieOptions.domain.slice(1))).toBe(true);
    });
  });
});
