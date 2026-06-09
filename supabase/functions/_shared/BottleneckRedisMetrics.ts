import { createRedis, type RedisClient } from "./Redis.ts";

/**
 * Bottleneck (ioredis/Upstash) stores limiter state under keys b_<id>_settings, etc.
 * See https://github.com/SGrondin/bottleneck — Scripts.allKeys in lib/Scripts.js
 */

const METRICS_LUA = `
local id = ARGV[1]
local now = tonumber(ARGV[2])
local settings_key = "b_" .. id .. "_settings"
local client_running_key = "b_" .. id .. "_client_running"
local client_last_seen_key = "b_" .. id .. "_client_last_seen"
local client_num_queued_key = "b_" .. id .. "_client_num_queued"

if redis.call('exists', settings_key) == 0 then
  return nil
end

local running = tonumber(redis.call('hget', settings_key, 'running')) or 0
local concurrent_clients = tonumber(redis.call('zcount', client_running_key, '(0', '+inf')) or 0

local clientTimeout = tonumber(redis.call('hget', settings_key, 'clientTimeout')) or 10000
local valid_clients = redis.call('zrangebyscore', client_last_seen_key, (now - clientTimeout), 'inf')
local queued_sum = 0
if #valid_clients > 0 then
  local client_queued = redis.call('hmget', client_num_queued_key, unpack(valid_clients))
  for i = 1, #client_queued do
    queued_sum = queued_sum + (tonumber(client_queued[i]) or 0)
  end
end

return { running, concurrent_clients, queued_sum }
`;

export type BottleneckLimiterSnapshot = {
  /** Bottleneck limiter id (same string passed to new Bottleneck({ id })) */
  limiter_id: string;
  /** Total running job weight (matches Bottleneck Redis "running" in settings) */
  running: number;
  /** Clients with running work (ZSET client_running score greater than 0) */
  concurrent_clients: number;
  /** Queued jobs across clients still within clientTimeout (same logic as Bottleneck queued.lua) */
  queued: number;
};

function settingsKeyToLimiterId(key: string): string | null {
  const suffix = "_settings";
  if (!key.startsWith("b_") || !key.endsWith(suffix)) return null;
  return key.slice(2, -suffix.length);
}

/** Upper bound on limiters exported per scrape (cardinality / latency). Override via METRICS_MAX_BOTTLENECK_LIMITERS. */
const DEFAULT_MAX_BOTTLENECK_LIMITERS = 200;
const ABSOLUTE_MAX_BOTTLENECK_LIMITERS = 5000;

function readMaxExportedLimiters(): number {
  const raw = Deno.env.get("METRICS_MAX_BOTTLENECK_LIMITERS");
  const parsed = raw != null && raw !== "" ? Number.parseInt(raw, 10) : DEFAULT_MAX_BOTTLENECK_LIMITERS;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_BOTTLENECK_LIMITERS;
  return Math.min(parsed, ABSOLUTE_MAX_BOTTLENECK_LIMITERS);
}

async function scanAllSettingsKeys(redis: RedisClient): Promise<string[]> {
  const maxLimiters = readMaxExportedLimiters();
  let cursor = 0;
  const ids = new Set<string>();
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "b_*_settings", count: 500 });
    cursor = nextCursor;
    for (const key of keys) {
      const id = settingsKeyToLimiterId(key);
      if (id) ids.add(id);
    }
  } while (cursor !== 0);

  const sorted = Array.from(ids).sort();
  if (sorted.length > maxLimiters) {
    console.warn(
      `Bottleneck Redis metrics: capping exported limiters from ${sorted.length} to ${maxLimiters} (raise METRICS_MAX_BOTTLENECK_LIMITERS if needed)`
    );
    return sorted.slice(0, maxLimiters);
  }
  return sorted;
}

function safeNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseEvalTriple(raw: unknown): { running: number; concurrent_clients: number; queued: number } | null {
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  return {
    running: safeNum(raw[0]),
    concurrent_clients: safeNum(raw[1]),
    queued: safeNum(raw[2])
  };
}

/**
 * Snapshot Bottleneck limiters from the shared Redis store.
 *
 * Connects via `createRedis()` — the same env-based factory the app's limiters
 * use: `REDIS_URL` (real ioredis) first, then `UPSTASH_REDIS_REST_*`. Returns []
 * if neither is configured.
 *
 * Discovery is capped per scrape (default 200, max 5000) via `METRICS_MAX_BOTTLENECK_LIMITERS`
 * to bound Prometheus cardinality and scrape time.
 *
 * Throws if at least one limiter was discovered but every EVAL failed or returned no data,
 * so callers can record a single error in Sentry.
 */
export async function collectBottleneckRedisSnapshots(): Promise<BottleneckLimiterSnapshot[]> {
  // createRedis picks ioredis (REDIS_URL) or the Upstash REST adapter
  // automatically; both speak the SCAN + EVAL subset Bottleneck stores
  // its limiter state under. Returns null when Redis isn't configured.
  const redis = createRedis();
  if (!redis) {
    return [];
  }
  const limiterIds = await scanAllSettingsKeys(redis);
  const now = Date.now();

  const snapshots = await Promise.all(
    limiterIds.map(async (limiter_id) => {
      try {
        const raw = await redis.eval(METRICS_LUA, [], [limiter_id, String(now)]);
        const parsed = parseEvalTriple(raw);
        if (!parsed) {
          console.warn(
            `Bottleneck metrics: EVAL returned no data for limiter_id=${limiter_id} (settings key likely removed after scan)`
          );
          return null;
        }
        return {
          limiter_id,
          running: parsed.running,
          concurrent_clients: parsed.concurrent_clients,
          queued: parsed.queued
        } satisfies BottleneckLimiterSnapshot;
      } catch (err) {
        console.error(`Bottleneck metrics: EVAL failed for limiter_id=${limiter_id}`, err);
        return null;
      }
    })
  );

  const ok = snapshots.filter((s): s is BottleneckLimiterSnapshot => s != null);
  if (limiterIds.length > 0 && ok.length === 0) {
    throw new Error(`Bottleneck Redis metrics: all ${limiterIds.length} limiter EVALs failed or returned no data`);
  }
  return ok;
}
