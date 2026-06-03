/**
 * Shared Next.js cache handler (Data Cache + Full Route Cache).
 *
 * Why: with >1 web replica and Next's default cache, each pod caches in its own
 * memory/filesystem, so `revalidateTag()` only invalidates the replica that
 * handled the request — the others serve stale data until their own revalidate
 * window (up to 1h here). Backing the cache with the shared in-cluster Redis
 * makes the cache (and tag revalidation) global across replicas.
 *
 * Falls back to a per-process in-memory Map when REDIS_URL is unset, so builds
 * / deployments without Redis behave exactly as the stock handler would.
 *
 * Tag invalidation uses the timestamp scheme: revalidateTag(t) records
 * `tag:<t> = now`; get() drops an entry whose lastModified predates any of its
 * tags' revalidation time. Keys are namespaced by NEXT_CACHE_PREFIX so the
 * shared Redis instance (also used by previews / Bottleneck / webhook status)
 * doesn't cross-pollinate.
 */
const PREFIX = process.env.NEXT_CACHE_PREFIX || "nextcache";
const entryKey = (k) => `${PREFIX}:entry:${k}`;
const tagKey = (t) => `${PREFIX}:tag:${t}`;
const MAX_TTL_SECONDS = 60 * 60 * 24; // GC cap; freshness is governed by tags + Next's own revalidate

// JSON.stringify renders Buffers as { type: "Buffer", data: [...] }; revive them
// so ROUTE / APP_PAGE cache bodies round-trip intact.
function reviver(_key, value) {
  if (value && value.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (!global.__nextSharedRedis) {
    const IORedis = require("ioredis");
    const Ctor = IORedis.default || IORedis;
    global.__nextSharedRedis = new Ctor(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      // Don't let cache failures take down rendering — degrade to misses.
      retryStrategy: (times) => Math.min(times * 200, 2000)
    });
    global.__nextSharedRedis.on("error", () => {});
  }
  return global.__nextSharedRedis;
}

module.exports = class SharedCacheHandler {
  constructor() {
    this.redis = getRedis();
    if (!this.redis && !global.__nextMemCache) global.__nextMemCache = new Map();
    this.mem = global.__nextMemCache;
  }

  async get(key) {
    if (!this.redis) return this.mem.get(key) || null;
    try {
      const raw = await this.redis.get(entryKey(key));
      if (!raw) return null;
      const entry = JSON.parse(raw, reviver); // { value, lastModified, tags }
      const tags = entry.tags || [];
      if (tags.length) {
        const revs = await this.redis.mget(tags.map(tagKey));
        for (const r of revs) {
          if (r && Number(r) > entry.lastModified) {
            this.redis.del(entryKey(key)).catch(() => {});
            return null;
          }
        }
      }
      return { lastModified: entry.lastModified, value: entry.value };
    } catch {
      return null;
    }
  }

  async set(key, value, ctx) {
    const tags = (ctx && ctx.tags) || [];
    const lastModified = Date.now();
    if (!this.redis) {
      this.mem.set(key, { lastModified, value, tags });
      return;
    }
    try {
      const payload = JSON.stringify({ value, lastModified, tags });
      await this.redis.set(entryKey(key), payload, "EX", MAX_TTL_SECONDS);
    } catch {
      /* degrade to no-op */
    }
  }

  async revalidateTag(tags) {
    const arr = Array.isArray(tags) ? tags : [tags];
    if (!arr.length) return;
    if (!this.redis) {
      for (const [k, e] of this.mem) {
        if ((e.tags || []).some((t) => arr.includes(t))) this.mem.delete(k);
      }
      return;
    }
    try {
      const now = Date.now();
      const pipe = this.redis.pipeline();
      for (const t of arr) pipe.set(tagKey(t), String(now), "EX", MAX_TTL_SECONDS);
      await pipe.exec();
    } catch {
      /* degrade to no-op */
    }
  }

  resetRequestCache() {}
};
