import { Redis as UpstashRedis } from "https://deno.land/x/upstash_redis@v1.22.0/mod.ts";
import * as Sentry from "npm:@sentry/deno";
type EventHandler = (...args: unknown[]) => void;

// Simple in-process channel bus to emulate pub/sub across duplicate() connections in the same runtime
const channelBus: Map<string, Set<Redis>> = new Map();

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

    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("Redis adapter initialized", { hasUrl: Boolean(url), hasToken: Boolean(token) });
    }

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

  // ioredis API: duplicate returns a new connection with same options
  duplicate() {
    const newRedis = new Redis(this.initOptions);
    // Copy defined scripts to the new instance
    for (const [name, script] of this.scripts.entries()) {
      newRedis.defineCommand(name, { lua: script });
    }
    return newRedis;
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
          console.log("eval script", { 
            name, 
            numKeys, 
            keysCount: keys.length, 
            argvCount: argv.length,
            rawArgsCount: args.length,
            firstKey: keys[0],
            firstArg: argv[0],
            allKeys: keys,
            scriptLength: script.length
          });
        }
        
        // Check if Upstash client has eval method
        const clientAsAny = this.client as unknown as Record<string, unknown>;
        if (typeof clientAsAny.eval !== "function") {
          throw new Error("Upstash Redis client does not support EVAL command");
        }
        
        const result = await (
          this.client as unknown as {
            eval: (script: string, keys: string[], args: (string | number)[]) => Promise<unknown>;
          }
        ).eval(script, keys, argv);
        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.log("eval script result", { name, result });
        }
        if (cb) cb(null, result);
        return result;
      } catch (error) {
        Sentry.captureException(error);
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
    const emitError = this.emit.bind(this);
    const executeCommand = this.executeCommand.bind(this);
    const scripts = this.scripts; // Capture for closure

    // Capture credentials at pipeline creation time
    const url = String(
      this.initOptions.url ||
        Deno.env.get("UPSTASH_REDIS_REST_URL") ||
        (this.initOptions.host ? `https://${this.initOptions.host}` : "")
    );
    const token = String(
      this.initOptions.token || this.initOptions.password || Deno.env.get("UPSTASH_REDIS_REST_TOKEN") || ""
    );

    return {
      async exec() {
        const out: Array<[unknown, unknown]> = [];

        if (commands.length === 0) {
          return out;
        }

        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.log("pipeline exec", { 
            commandCount: commands.length, 
            commands: commands.map((cmd) => cmd[0])
          });
        }

        // Check if ANY commands are custom scripts (defined via defineCommand)
        const hasCustomScripts = commands.some(cmd => {
          const commandName = String(cmd[0]);
          return scripts.has(commandName);
        });
        
        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.log(`  pipeline hasCustomScripts: ${hasCustomScripts}, executing ${hasCustomScripts ? 'SEQUENTIALLY' : 'BATCHED'}`);
        }

        // If there are custom scripts, we must execute sequentially because
        // Upstash pipeline doesn't support our defineCommand Lua scripts
        if (hasCustomScripts) {
          for (const cmd of commands) {
            try {
              const result = await executeCommand(cmd);
              out.push([null, result]);
            } catch (err) {
              out.push([err, null]);
              emitError("error", err);
            }
          }
          return out;
        }

        // No custom scripts - use Upstash's atomic pipeline endpoint
        try {
          const pipelineCommands = commands.map((cmd) => cmd);

          const pipelineUrl = `${url}/pipeline`;
          const response = await fetch(pipelineUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(pipelineCommands)
          });

          if (!response.ok) {
            throw new Error(`Pipeline request failed: ${response.status} ${response.statusText}`);
          }

          const results = (await response.json()) as Array<{ result?: unknown; error?: string }>;

          for (let i = 0; i < commands.length; i++) {
            const resp = results[i];

            if (resp && typeof resp === "object" && "error" in resp) {
              out.push([resp.error, null]);
              emitError("error", resp.error);
            } else if (resp && typeof resp === "object" && "result" in resp) {
              out.push([null, resp.result]);
            } else {
              out.push([null, resp]);
            }
          }
        } catch (err) {
          for (let i = 0; i < commands.length; i++) {
            out.push([err, null]);
            emitError("error", err);
          }
        }

        return out;
      }
    };
  }

  // Helper method to establish SSE connection for a channel
  private async establishSSEConnection(channel: string) {
    if (this.sseConnections.has(channel)) {
      return; // Already connected
    }

    // Prevent concurrent connection attempts
    if (this.sseConnectionsInProgress.has(channel)) {
      if (Deno.env.get("REDIS_DEBUG") === "true") {
        console.log("SSE connection already in progress", { channel });
      }
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

      if (Deno.env.get("REDIS_DEBUG") === "true") {
        console.log("SSE connection established", { channel });
      }

      // Start reading SSE events
      this.readSSEEvents(channel, reader);
    } catch (error) {
      if (Deno.env.get("REDIS_DEBUG") === "true") {
        console.error("SSE connection failed", { channel, error });
      }
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
          if (Deno.env.get("REDIS_DEBUG") === "true") {
            console.log("SSE stream ended", { channel });
          }
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
                  if (Deno.env.get("REDIS_DEBUG") === "true") {
                    console.log("SSE message received", { channel, messagePayload });
                  }
                  // Emit message to local subscribers (channel and message payload)
                  this.emit("message", channel, messagePayload);
                } else if (messageType === "subscribe" || messageType === "unsubscribe") {
                  // Subscription/unsubscription confirmation - just log if debugging
                  if (Deno.env.get("REDIS_DEBUG") === "true") {
                    console.log(`SSE ${messageType} confirmation`, { data });
                  }
                } else if (messageType === "pmessage" && parts.length >= 4) {
                  // Pattern message - extract payload (everything after third comma)
                  const messagePayload = parts.slice(3).join(",");
                  if (Deno.env.get("REDIS_DEBUG") === "true") {
                    console.log("SSE pmessage received", { channel, messagePayload });
                  }
                  this.emit("pmessage", parts[1], parts[2], messagePayload);
                } else if (messageType === "psubscribe" || messageType === "punsubscribe") {
                  // Pattern subscription confirmation - just log if debugging
                  if (Deno.env.get("REDIS_DEBUG") === "true") {
                    console.log(`SSE ${messageType} confirmation`, { data });
                  }
                } else {
                  // Unknown message type - log but don't treat as error
                  if (Deno.env.get("REDIS_DEBUG") === "true") {
                    console.log("SSE unknown message type", { channel, data });
                  }
                }
              } catch (parseError) {
                Sentry.captureException(parseError);
                if (Deno.env.get("REDIS_DEBUG") === "true") {
                  console.error("Failed to parse SSE message", { channel, data, parseError });
                }
              }
            }
          }
        }
      }
    } catch (error) {
      Sentry.captureException(error);
      if (Deno.env.get("REDIS_DEBUG") === "true") {
        console.error("SSE read error", { channel, error });
      }
    } finally {
      this.sseConnections.delete(channel);
      this.sseAbortControllers.delete(channel);

      // Auto-reconnect if this channel is still subscribed
      // This handles cases where the SSE connection drops/times out
      if (this.subscribedChannels.has(channel)) {
        if (Deno.env.get("REDIS_DEBUG") === "true") {
          console.log("SSE connection lost, attempting to reconnect", { channel });
        }
        // Reconnect after a short delay to avoid tight reconnection loop
        setTimeout(() => {
          if (this.subscribedChannels.has(channel)) {
            void this.establishSSEConnection(channel).catch((err) => {
              if (Deno.env.get("REDIS_DEBUG") === "true") {
                console.error("SSE reconnection failed", { channel, error: err });
              }
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

    if (Deno.env.get("REDIS_DEBUG") === "true") {
      console.log("SSE connection cleaned up", { channel });
    }
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
      if (set.size === 0) {
        channelBus.delete(channel);
        // Cleanup SSE connection when no more local subscribers
        await this.cleanupSSEConnection(channel);
      }
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

    // Cleanup any remaining SSE connections
    for (const channel of Array.from(this.sseConnections.keys())) {
      void this.cleanupSSEConnection(channel);
    }
  }
}
