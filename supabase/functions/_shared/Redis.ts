import { Redis as UpstashRedis } from "https://esm.sh/@upstash/redis";
import IORedisDefault, { type Redis as IORedisInstance } from "npm:ioredis";
import * as Sentry from "npm:@sentry/deno";

// npm:ioredis ships as a CJS default export; the named import above is
// types-only. Picking the runtime constructor based on what esm interop
// hands back keeps both Deno's npm: resolver and a future esm.sh path
// happy.
// deno-lint-ignore no-explicit-any
const IORedisCtor: any = (IORedisDefault as unknown as { default?: unknown }).default ?? IORedisDefault;

type EventHandler = (...args: unknown[]) => void;

// Simple in-process channel bus to emulate pub/sub across duplicate() connections in the same runtime
const channelBus: Map<string, Set<Redis>> = new Map();

/**
 * Public type for the result of `createRedis()`.
 *
 * Both backends — real `ioredis` and the Upstash REST adapter below —
 * speak the same get/set/setex/scan/eval/etc. surface at runtime, but
 * each is duck-typed differently in TypeScript:
 *
 *   - ioredis's npm types only partially survive Deno's `npm:` resolver
 *   - the Upstash adapter forwards unknown methods via Proxy at runtime,
 *     so its class declaration intentionally lists none of them
 *
 * A structural union `IORedis | Redis` therefore drops every command
 * method off the intersection and every consumer breaks. Since the
 * runtime contract is just "the Redis command set", we type the result
 * as `any` and document the contract in this comment instead of
 * fighting the type system. Consumers still see the right shape from
 * the surrounding code (Bottleneck takes whatever, our wrappers know
 * what they want to call).
 */
// deno-lint-ignore no-explicit-any
export type RedisClient = any;

/**
 * Build a Redis client based on what's configured in the environment:
 *
 *   REDIS_URL set                 → real ioredis (TCP redis://...)
 *   UPSTASH_REDIS_REST_URL set    → the Upstash REST adapter below
 *   nothing                       → null (caller handles "Redis disabled")
 *
 * The TCP path is what the chart's `redis.provider=shared` mode wires
 * up. The REST path remains for managed Upstash deploys. The adapter
 * class below is intentionally untouched so existing callers that
 * `new Redis({url, token})` directly keep working unchanged.
 *
 * Opts let callers override the env-based pickup (used by
 * github-repo-webhook to build a client from supabase-stored creds and
 * by BottleneckRedisMetrics to construct a metrics-only client).
 */
export function createRedis(
  opts: { redisUrl?: string; upstashUrl?: string; upstashToken?: string } = {}
): RedisClient | null {
  const redisUrl = opts.redisUrl || Deno.env.get("REDIS_URL");
  if (redisUrl) {
    return new IORedisCtor(redisUrl) as IORedisInstance;
  }
  const upstashUrl = opts.upstashUrl || Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = opts.upstashToken || Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl && upstashToken) {
    return new Redis({ url: upstashUrl, token: upstashToken });
  }
  return null;
}

/**
 * Build the `{ datastore, clientOptions, Redis }` block a Bottleneck
 * constructor expects, picking real ioredis vs the Upstash REST adapter
 * based on the same env precedence as `createRedis()`. Returns null when
 * neither is configured — callers should fall back to a local-only
 * limiter (no `datastore`, no `clientOptions`, no `Redis` field).
 *
 * Centralising the wiring here lets every Bottleneck call site stay
 * one line; before this helper each one had to know how to construct
 * clientOptions for one backend.
 */
// deno-lint-ignore no-explicit-any
export function bottleneckRedisOptions(): {
  datastore: "ioredis";
  Redis: any;
  clientOptions: Record<string, unknown>;
} | null {
  const redisUrl = Deno.env.get("REDIS_URL");
  if (redisUrl) {
    // ioredis accepts the URL constructor form directly, but Bottleneck
    // does `new Redis(clientOptions)` — so we pass the URL as the sole
    // positional via the special `path` field that ioredis recognises
    // when its only option is a URL string. Most cleanly we parse it
    // and hand Bottleneck the discrete fields it expects.
    const u = new URL(redisUrl);
    const clientOptions: Record<string, unknown> = {
      host: u.hostname,
      port: Number(u.port) || 6379
    };
    if (u.password) clientOptions.password = decodeURIComponent(u.password);
    if (u.username) clientOptions.username = decodeURIComponent(u.username);
    if (u.protocol === "rediss:") clientOptions.tls = {};
    return { datastore: "ioredis", Redis: IORedisCtor, clientOptions };
  }
  const upstashUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl && upstashToken) {
    return {
      datastore: "ioredis",
      Redis,
      clientOptions: {
        host: upstashUrl.replace("https://", ""),
        password: upstashToken,
        username: "default"
      }
    };
  }
  return null;
}

/**
 * IORedis-compatible adapter backed by Upstash Redis REST client.
 * Implements the subset of the API used by Bottleneck's IORedis store.
 *
 * Uses Proxy to forward all unknown methods to the underlying Upstash client.
 */
export class Redis {
  private client: UpstashRedis;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private scripts: Map<string, string> = new Map();
  private scriptSHAs: Map<string, string> = new Map();
  private initOptions: Record<string, unknown>;
  private subscribedChannels: Set<string> = new Set();
  private sseConnections: Map<string, ReadableStreamDefaultReader<Uint8Array>> = new Map();
  private sseAbortControllers: Map<string, AbortController> = new Map();
  private sseConnectionsInProgress: Set<string> = new Set();
  status: string = "ready";

  constructor(clientOptions: Record<string, unknown> = {}) {
    this.initOptions = { ...clientOptions };
    // Support both env-based and passed-in credentials
    const url = String(
      clientOptions.url ||
        Deno.env.get("UPSTASH_REDIS_REST_URL") ||
        (clientOptions.host ? `https://${clientOptions.host}` : "")
    );
    const token = String(
      clientOptions.token || clientOptions.password || Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || ""
    );
    this.client = new UpstashRedis({ url, token });

    Sentry.addBreadcrumb({
      category: "redis",
      message: "Redis adapter initialized",
      data: { hasUrl: Boolean(url), hasToken: Boolean(token) },
      level: "debug"
    });

    // Emit ready asynchronously to mimic ioredis behavior
    queueMicrotask(() => this.emit("ready"));

    // Return a Proxy that forwards unknown method calls to the underlying Upstash client
    // This allows Redis commands like get, set, incr, etc. to work transparently
    return new Proxy(this, {
      get(target, prop, receiver) {
        // First check if the property exists on the Redis wrapper class
        const targetValue = Reflect.get(target, prop, receiver);
        if (targetValue !== undefined) {
          return targetValue;
        }

        // Then check the underlying Upstash client
        const clientAsAny = target.client as unknown as Record<string, unknown>;
        const clientMethod = clientAsAny[String(prop)];

        if (typeof clientMethod === "function") {
          // Bind the method to the client so 'this' works correctly
          return clientMethod.bind(target.client);
        }

        return undefined;
      }
    });
  }

  // EventEmitter-like API expected by bottleneck
  on(event: string, handler: EventHandler) {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event)!.add(handler);
    return this;
  }

  once(event: string, handler: EventHandler) {
    const wrapper: EventHandler = (...args: unknown[]) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, handler: EventHandler) {
    this.eventHandlers.get(event)?.delete(handler);
    return this;
  }

  private emit(event: string, ...args: unknown[]) {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(...args);
  }

  setMaxListeners() {
    // No-op for compatibility
    return this;
  }

  // ioredis API: pipeline(commands?) creates a pipeline that buffers commands and runs them with exec()
  // Bottleneck's __runCommand__ calls client.pipeline([["del", key]]).exec()
  pipeline(commands?: (string | number)[][]) {
    const client = this.client;
    const buffered: { cmd: string; args: (string | number)[] }[] = [];
    if (commands) {
      for (const cmd of commands) {
        buffered.push({ cmd: String(cmd[0]).toLowerCase(), args: cmd.slice(1) });
      }
    }
    const self = {
      exec: async (): Promise<[null | Error, unknown][]> => {
        const results: [null | Error, unknown][] = [];
        for (const { cmd, args } of buffered) {
          try {
            const clientAny = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
            const fn = clientAny[cmd];
            if (typeof fn === "function") {
              const result = await fn.bind(client)(...args);
              results.push([null, result]);
            } else {
              results.push([new Error(`Unknown command: ${cmd}`), null]);
            }
          } catch (e) {
            results.push([e instanceof Error ? e : new Error(String(e)), null]);
          }
        }
        return results;
      }
    };
    return self;
  }

  // ioredis API: duplicate returns a new connection with same options
  duplicate() {
    const newRedis = new Redis(this.initOptions);
    // Copy defined scripts and their SHAs to the new instance
    for (const [name, script] of this.scripts.entries()) {
      newRedis.defineCommand(name, { lua: script });
      // Copy the SHA if it was already loaded
      const sha = this.scriptSHAs.get(name);
      if (sha) {
        newRedis.scriptSHAs.set(name, sha);
      }
    }
    return newRedis;
  }

  // ioredis API: defineCommand(name, { lua }) registers a script callable as client[name](...)
  defineCommand(name: string, options: { lua: string }) {
    this.scripts.set(name, options.lua);
    // Capture the actual client and map references, not 'this'
    // This ensures each duplicated instance uses its own client and scripts
    const client = this.client;
    const scripts = this.scripts;
    const scriptSHAs = this.scriptSHAs;

    const fn = async (...args: unknown[]) => {
      const maybeCb = args[args.length - 1];
      const hasCallback = typeof maybeCb === "function";
      const cb = hasCallback ? (maybeCb as (err: unknown, result?: unknown) => void) : undefined;

      // ioredis passes: numKeys, ...keys, ...argv, [cb]
      const numKeys = Number(args[0]);
      const keys = (args.slice(1, 1 + numKeys) as string[]) || [];
      const argv = (args.slice(1 + numKeys, hasCallback ? -1 : undefined) as (string | number)[]) || [];
      const script = scripts.get(name) || "";

      const maxRetries = 3;
      let lastError: unknown;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Load script and get SHA if not already loaded
          let sha = scriptSHAs.get(name);
          if (!sha) {
            Sentry.addBreadcrumb({
              category: "redis",
              message: "Loading script",
              data: { name, scriptLength: script.length, attempt },
              level: "debug"
            });
            sha = await client.scriptLoad(script);
            scriptSHAs.set(name, sha);
            Sentry.addBreadcrumb({
              category: "redis",
              message: "Script loaded",
              data: { name, sha, attempt },
              level: "debug"
            });
          }

          Sentry.addBreadcrumb({
            category: "redis",
            message: "evalsha script",
            data: {
              name,
              sha,
              numKeys,
              keysCount: keys.length,
              argvCount: argv.length,
              rawArgsCount: args.length,
              firstKey: keys[0],
              firstArg: argv[0],
              allKeys: keys,
              attempt
            },
            level: "debug"
          });

          const result = await client.evalsha(sha, keys, argv);
          Sentry.addBreadcrumb({
            category: "redis",
            message: "evalsha script result",
            data: { name, result, attempt },
            level: "debug"
          });
          if (cb) cb(null, result);
          return result;
        } catch (error) {
          lastError = error;
          const errorMessage = String(error);
          console.log("evalsha script error", { name, errorMessage, attempt });

          // If script was evicted from cache, reload it
          if (errorMessage.includes("NOSCRIPT")) {
            Sentry.addBreadcrumb({
              category: "redis",
              message: "Script evicted from cache, reloading",
              data: { name, attempt },
              level: "warning"
            });
            // Clear the cached SHA and retry on next iteration
            scriptSHAs.delete(name);

            // If this is the last attempt, don't wait
            if (attempt < maxRetries - 1) {
              const backoffMs = Math.pow(2, attempt) * 100; // 100ms, 200ms, 400ms
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
            continue;
          }

          // Settings not yet initialized (race between heartbeat and init) — retry with backoff
          if (errorMessage.includes("SETTINGS_KEY_NOT_FOUND")) {
            Sentry.addBreadcrumb({
              category: "redis",
              message: "Bottleneck settings not found, retrying (init may still be running)",
              data: { name, attempt },
              level: "warning"
            });
            if (attempt < maxRetries - 1) {
              const backoffMs = Math.pow(2, attempt) * 500; // 500ms, 1000ms, 2000ms
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
            continue;
          }

          // Pipeline is empty — transient Upstash error, retry with backoff
          if (errorMessage.includes("Pipeline is empty")) {
            Sentry.addBreadcrumb({
              category: "redis",
              message: "Pipeline is empty, retrying",
              data: { name, attempt },
              level: "warning"
            });
            if (attempt < maxRetries - 1) {
              const backoffMs = Math.pow(2, attempt) * 500;
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
            continue;
          }

          // For UNKNOWN_CLIENT, immediately fail - the only fix is to make a new worker, it seems :(
          if (errorMessage.includes("UNKNOWN_CLIENT")) {
            throw new Error("UNKNOWN_CLIENT error, failing immediately");
          }

          // For non-retryable errors, throw immediately
          console.trace(error);
          console.error("evalsha script error (non-retryable)", { name, error, attempt });
          Sentry.addBreadcrumb({
            category: "redis",
            message: "evalsha script error (non-retryable)",
            data: { name, error, attempt },
            level: "error"
          });
          Sentry.captureException(error);
          if (cb) cb(error);
          else throw error;
        }
      }

      // All retries exhausted
      console.trace(lastError);
      console.error("evalsha script error after all retries", { name, error: lastError });
      Sentry.addBreadcrumb({
        category: "redis",
        message: "evalsha script error after all retries",
        data: { name, error: lastError, maxRetries },
        level: "error"
      });
      Sentry.captureException(lastError);
      if (cb) cb(lastError);
      else throw lastError;
    };
    // Attach callable script function directly on the instance
    (this as unknown as Record<string, unknown>)[name] = fn;
  }

  // Helper method to establish SSE connection for a channel
  private async establishSSEConnection(channel: string) {
    if (this.sseConnections.has(channel)) {
      return; // Already connected
    }

    // Prevent concurrent connection attempts
    if (this.sseConnectionsInProgress.has(channel)) {
      Sentry.addBreadcrumb({
        category: "redis",
        message: "SSE connection already in progress",
        data: { channel },
        level: "debug"
      });
      return;
    }

    this.sseConnectionsInProgress.add(channel);

    try {
      const url = String(
        this.initOptions.url ||
          Deno.env.get("UPSTASH_REDIS_REST_URL") ||
          (this.initOptions.host ? `https://${this.initOptions.host}` : "")
      );
      const token = String(
        this.initOptions.token || this.initOptions.password || Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || ""
      );

      const subscribeUrl = `${url}/subscribe/${channel}`;
      const abortController = new AbortController();
      this.sseAbortControllers.set(channel, abortController);

      const response = await fetch(subscribeUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache"
        },
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`SSE subscription failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body for SSE connection");
      }

      const reader = response.body.getReader();
      this.sseConnections.set(channel, reader);

      Sentry.addBreadcrumb({
        category: "redis",
        message: "SSE connection established",
        data: { channel },
        level: "debug"
      });

      // Start reading SSE events
      this.readSSEEvents(channel, reader);
    } catch (error) {
      Sentry.addBreadcrumb({
        category: "redis",
        message: "SSE connection failed",
        data: { channel, error },
        level: "error"
      });
      this.sseConnections.delete(channel);
      this.sseAbortControllers.delete(channel);
      throw error;
    } finally {
      this.sseConnectionsInProgress.delete(channel);
    }
  }

  // Helper method to read and parse SSE events
  private async readSSEEvents(channel: string, reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          Sentry.addBreadcrumb({
            category: "redis",
            message: "SSE stream ended",
            data: { channel },
            level: "debug"
          });
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim() === "") continue;

          if (line.startsWith("data: ")) {
            const data = line.slice(6); // Remove 'data: ' prefix
            if (data.trim() !== "") {
              try {
                // Upstash SSE format for Redis pub/sub messages:
                // "subscribe,channel,count" - subscription confirmation
                // "unsubscribe,channel,count" - unsubscription confirmation
                // "message,channel,payload" - actual pub/sub message
                // "psubscribe,pattern,count" - pattern subscription confirmation
                // "punsubscribe,pattern,count" - pattern unsubscription confirmation
                // "pmessage,pattern,channel,payload" - pattern message

                const parts = data.split(",");
                const messageType = parts[0];

                if (messageType === "message" && parts.length >= 3) {
                  // Extract the actual message payload (everything after the second comma)
                  const messagePayload = parts.slice(2).join(",");
                  Sentry.addBreadcrumb({
                    category: "redis",
                    message: "SSE message received",
                    data: { channel, messagePayload },
                    level: "debug"
                  });
                  // Emit message to local subscribers (channel and message payload)
                  this.emit("message", channel, messagePayload);
                } else if (messageType === "subscribe" || messageType === "unsubscribe") {
                  // Subscription/unsubscription confirmation - just log if debugging
                  Sentry.addBreadcrumb({
                    category: "redis",
                    message: `SSE ${messageType} confirmation`,
                    data: { data },
                    level: "debug"
                  });
                } else if (messageType === "pmessage" && parts.length >= 4) {
                  // Pattern message - extract payload (everything after third comma)
                  const messagePayload = parts.slice(3).join(",");
                  Sentry.addBreadcrumb({
                    category: "redis",
                    message: "SSE pmessage received",
                    data: { channel, messagePayload },
                    level: "debug"
                  });
                  this.emit("pmessage", parts[1], parts[2], messagePayload);
                } else if (messageType === "psubscribe" || messageType === "punsubscribe") {
                  // Pattern subscription confirmation - just log if debugging
                  Sentry.addBreadcrumb({
                    category: "redis",
                    message: `SSE ${messageType} confirmation`,
                    data: { data },
                    level: "debug"
                  });
                } else {
                  // Unknown message type - log but don't treat as error
                  Sentry.addBreadcrumb({
                    category: "redis",
                    message: "SSE unknown message type",
                    data: { channel, data },
                    level: "warning"
                  });
                }
              } catch (parseError) {
                Sentry.captureException(parseError);
                Sentry.addBreadcrumb({
                  category: "redis",
                  message: "Failed to parse SSE message",
                  data: { channel, data, parseError },
                  level: "error"
                });
              }
            }
          }
        }
      }
    } catch (error) {
      Sentry.captureException(error);
      Sentry.addBreadcrumb({
        category: "redis",
        message: "SSE read error",
        data: { channel, error },
        level: "error"
      });
    } finally {
      this.sseConnections.delete(channel);
      this.sseAbortControllers.delete(channel);

      // Auto-reconnect if this channel is still subscribed
      // This handles cases where the SSE connection drops/times out
      if (this.subscribedChannels.has(channel)) {
        Sentry.addBreadcrumb({
          category: "redis",
          message: "SSE connection lost, attempting to reconnect",
          data: { channel },
          level: "warning"
        });
        // Reconnect after a short delay to avoid tight reconnection loop
        setTimeout(() => {
          if (this.subscribedChannels.has(channel)) {
            void this.establishSSEConnection(channel).catch((err) => {
              Sentry.addBreadcrumb({
                category: "redis",
                message: "SSE reconnection failed",
                data: { channel, error: err },
                level: "error"
              });
              // Schedule another retry after exponential backoff
              // This will keep retrying as long as the channel is subscribed
            });
          }
        }, 1000); // 1 second delay before reconnect
      }
    }
  }

  // Helper method to cleanup SSE connection
  private async cleanupSSEConnection(channel: string) {
    const abortController = this.sseAbortControllers.get(channel);
    if (abortController) {
      abortController.abort();
      this.sseAbortControllers.delete(channel);
    }

    const reader = this.sseConnections.get(channel);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
      this.sseConnections.delete(channel);
    }

    Sentry.addBreadcrumb({
      category: "redis",
      message: "SSE connection cleaned up",
      data: { channel },
      level: "debug"
    });
  }

  // Pub/Sub
  async subscribe(channel: string, cb?: () => void) {
    if (!channelBus.has(channel)) channelBus.set(channel, new Set());
    channelBus.get(channel)!.add(this);
    this.subscribedChannels.add(channel);

    // Establish SSE connection for remote pub/sub
    // If not successful, we must throw an error to break the subscription chain
    await this.establishSSEConnection(channel);

    if (cb) cb();
    Sentry.addBreadcrumb({
      category: "redis",
      message: "subscribe",
      data: { channel },
      level: "debug"
    });
    await Promise.resolve();
  }

  async unsubscribe(channel: string) {
    this.subscribedChannels.delete(channel);
    const set = channelBus.get(channel);
    if (set) {
      set.delete(this);
      if (set.size === 0) {
        channelBus.delete(channel);
        // Cleanup SSE connection when no more local subscribers
        await this.cleanupSSEConnection(channel);
      }
    }
    Sentry.addBreadcrumb({
      category: "redis",
      message: "unsubscribe",
      data: { channel },
      level: "debug"
    });
    await Promise.resolve();
  }

  async publish(channel: string, message: string) {
    try {
      // Upstash client supports PUBLISH
      await this.client.publish(channel, message);
    } catch (err) {
      throw err;
    }
    Sentry.addBreadcrumb({
      category: "redis",
      message: "publish",
      data: { channel },
      level: "debug"
    });
    const set = channelBus.get(channel);
    if (set) {
      for (const sub of set) sub.emit("message", channel, message);
    }
  }

  // Lifecycle
  async quit() {
    await Promise.resolve();
    return "OK";
  }

  disconnect() {
    // Cleanup local subscriptions
    for (const ch of Array.from(this.subscribedChannels)) {
      void this.unsubscribe(ch);
    }

    // Cleanup any remaining SSE connections
    for (const channel of Array.from(this.sseConnections.keys())) {
      void this.cleanupSSEConnection(channel);
    }
  }
}
