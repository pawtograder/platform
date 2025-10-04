import { Redis as UpstashRedis } from "https://deno.land/x/upstash_redis@v1.22.0/mod.ts";

type EventHandler = (...args: unknown[]) => void;

// Simple in-process channel bus to emulate pub/sub across duplicate() connections in the same runtime
const channelBus: Map<string, Set<Redis>> = new Map();

/**
 * IORedis-compatible adapter backed by Upstash Redis REST client.
 * Implements the subset of the API used by Bottleneck's IORedis store.
 */
export class Redis {
  private client: UpstashRedis;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private scripts: Map<string, string> = new Map();
  private initOptions: Record<string, unknown>;
  private subscribedChannels: Set<string> = new Set();
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

    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("Redis adapter initialized", { hasUrl: Boolean(url), hasToken: Boolean(token) });
    }

    // Emit ready asynchronously to mimic ioredis behavior
    queueMicrotask(() => this.emit("ready"));
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

  // ioredis API: duplicate returns a new connection with same options
  duplicate() {
    return new Redis(this.initOptions);
  }

  // ioredis API: defineCommand(name, { lua }) registers a script callable as client[name](...)
  defineCommand(name: string, options: { lua: string }) {
    this.scripts.set(name, options.lua);
    const fn = async (...args: unknown[]) => {
      const maybeCb = args[args.length - 1];
      const hasCallback = typeof maybeCb === "function";
      const cb = hasCallback ? (maybeCb as (err: unknown, result?: unknown) => void) : undefined;

      // ioredis passes: numKeys, ...keys, ...argv, [cb]
      const numKeys = Number(args[0]);
      const keys = (args.slice(1, 1 + numKeys) as string[]) || [];
      const argv = (args.slice(1 + numKeys, hasCallback ? -1 : undefined) as (string | number)[]) || [];
      const script = this.scripts.get(name) || "";

      try {
        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.log("eval script", { name, numKeys, keysCount: keys.length, argvCount: argv.length });
        }
        const result = await (
          this.client as unknown as {
            eval: (script: string, keys: string[], args: (string | number)[]) => Promise<unknown>;
          }
        ).eval(script, keys, argv);
        if (cb) cb(null, result);
        return result;
      } catch (error) {
        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.error("eval script error", { name, error });
        }
        if (cb) cb(error);
        else throw error;
      }
    };
    // Attach callable script function directly on the instance
    (this as unknown as Record<string, unknown>)[name] = fn;
  }

  // Command executor used by pipeline
  private async executeCommand(cmd: [string, ...unknown[]]) {
    const [command, ...args] = cmd;
    const commandName = String(command);

    // Custom script defined via defineCommand
    const selfTarget = this as unknown as Record<string, unknown>;
    const selfFn = selfTarget[commandName];
    if (typeof selfFn === "function") {
      return await (selfFn as (...p: unknown[]) => Promise<unknown>)(...args);
    }

    // Direct Upstash command
    const target = this.client as unknown as Record<string, unknown>;
    const method = target[commandName];
    if (typeof method === "function") {
      return await (method as (...p: unknown[]) => Promise<unknown>).apply(this.client, args);
    }
    throw new Error(`Unsupported command in pipeline: ${commandName}`);
  }

  // ioredis API: pipeline([...]).exec() => [[err, result], ...]
  pipeline(commands: Array<[string, ...unknown[]]>) {
    const execCmd = this.executeCommand.bind(this);
    const emitError = this.emit.bind(this);
    return {
      async exec() {
        const out: Array<[unknown, unknown]> = [];
        for (const cmd of commands) {
          try {
            if (Deno.env.get("REDIS_DEBUG") === "true") {
              console.log("pipeline exec", { cmd: cmd[0] });
            }
            const res = await execCmd(cmd);
            out.push([null, res]);
          } catch (err) {
            out.push([err, null]);
            emitError("error", err);
          }
        }
        return out;
      }
    };
  }

  // Pub/Sub
  async subscribe(channel: string, cb?: () => void) {
    if (!channelBus.has(channel)) channelBus.set(channel, new Set());
    channelBus.get(channel)!.add(this);
    this.subscribedChannels.add(channel);
    if (cb) cb();
    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("subscribe", { channel });
    }
    await Promise.resolve();
  }

  async unsubscribe(channel: string) {
    this.subscribedChannels.delete(channel);
    const set = channelBus.get(channel);
    if (set) {
      set.delete(this);
      if (set.size === 0) channelBus.delete(channel);
    }
    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("unsubscribe", { channel });
    }
    await Promise.resolve();
  }

  async publish(channel: string, message: string) {
    try {
      // Upstash client supports PUBLISH
      await (this.client as unknown as { publish: (c: string, m: string) => Promise<number> }).publish(
        channel,
        message
      );
    } catch (err) {
      throw err;
      // Ignore remote publish failures; still deliver locally
    }
    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("publish", { channel });
    }
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
  }
}
