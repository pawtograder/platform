/**
 * AtBridge — in-process HTTP MCP server exposing the AtHarness to a spawned
 * `claude -p` agent (a11y-judge v2, Wave 2).
 *
 * Topology (decided by Spike S2): the Playwright host process IS the MCP
 * server — `--mcp-config` supports `{type:"http"}` servers, so there is no
 * stdio proxy hop. Binds 127.0.0.1 on an ephemeral port and requires a
 * per-run bearer token (any local process could otherwise drive an
 * authenticated browser session while the bridge is up).
 *
 * Every tool call is recorded HOST-SIDE into TrajectoryStep records — the
 * single source of truth the agent cannot misreport. Tool results carry only
 * the noise-filtered observation; raw phrases go into the step record.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AtHarness } from "./atHarness";
import { BRIDGE_PATH, MCP_SERVER_NAME, TOOL_SPECS } from "./toolSurface";
import type { TrajectoryStep } from "../schema/trajectory";

export { MCP_SERVER_NAME, BRIDGE_PATH, TOOL_SPECS } from "./toolSurface";

export class AtBridge {
  readonly steps: TrajectoryStep[] = [];
  readonly token = randomBytes(16).toString("hex");
  private httpServer: Server | null = null;
  private port = 0;

  constructor(private readonly harness: AtHarness) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}${BRIDGE_PATH}`;
  }

  /** Inline value for `--mcp-config` (written to a temp file by the runner). */
  mcpConfig(): string {
    return JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: this.url,
          headers: { Authorization: `Bearer ${this.token}` }
        }
      }
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.httpServer!.listen(0, "127.0.0.1", resolve));
    this.port = (this.httpServer.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()));
    this.httpServer = null;
  }

  /** Stateless MCP: fresh server+transport per request, shared harness state. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length ? JSON.parse(raw) : undefined;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await this.buildMcpServer().connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  }

  private buildMcpServer(): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" });
    for (const spec of TOOL_SPECS) {
      const inputSchema = spec.arg ? { [spec.arg.name]: z.string().describe(spec.arg.description) } : {};
      server.registerTool(
        spec.command,
        { description: spec.description, inputSchema },
        async (args: Record<string, string>) => {
          const arg = spec.arg ? args[spec.arg.name] : undefined;
          const startedTimestamp = new Date().toISOString();
          const observation = await this.harness.run(spec.command, arg);
          const hStep = this.harness.steps[this.harness.steps.length - 1];
          this.steps.push({
            index: this.steps.length,
            tool: spec.command,
            argsJson: JSON.stringify(arg === undefined ? {} : { [spec.arg!.name]: arg }),
            resultJson: JSON.stringify(observation),
            rawSpoken: hStep?.rawSpoken ?? [],
            startedTimestamp,
            endedTimestamp: new Date().toISOString()
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(observation) }] };
        }
      );
    }
    return server;
  }
}
