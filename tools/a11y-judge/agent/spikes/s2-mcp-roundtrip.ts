/**
 * Spike S2: prove `claude -p` (standing OAuth) can drive an in-process HTTP MCP
 * server and return structured output. Gate for a11y-judge v2 Wave 0.
 *
 * Run: npx tsx s2-mcp-roundtrip.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = randomBytes(16).toString("hex");
const toolCallsSeen: Array<{ tool: string; args: unknown }> = [];

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "at", version: "0.0.1" });
  server.registerTool(
    "echo",
    {
      description: "Echoes the message back with an 'echo:' prefix. Call this exactly once.",
      inputSchema: { message: z.string().describe("text to echo") }
    },
    async ({ message }) => {
      toolCallsSeen.push({ tool: "echo", args: { message } });
      console.error(`[bridge] echo tool called with message=${JSON.stringify(message)}`);
      return { content: [{ type: "text", text: `echo:${message}` }] };
    }
  );
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length ? JSON.parse(raw) : undefined;
}

async function main() {
  // Stateless mode: fresh server+transport per request (SDK-recommended for
  // sessionless HTTP); handlers close over shared host state (toolCallsSeen).
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => transport.close());
      const server = buildMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[bridge] request error:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as { port: number }).port;
  console.error(`[bridge] listening on 127.0.0.1:${port}`);

  const mcpConfig = {
    mcpServers: {
      at: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${TOKEN}` }
      }
    }
  };
  const cfgPath = join(mkdtempSync(join(tmpdir(), "s2-mcp-")), "mcp-config.json");
  writeFileSync(cfgPath, JSON.stringify(mcpConfig));

  const outputSchema = {
    type: "object",
    properties: { echoed: { type: "string", description: "exact text returned by the echo tool" } },
    required: ["echoed"],
    additionalProperties: false
  };

  const args = [
    "-p",
    "--model",
    "claude-opus-4-8",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    cfgPath,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__at__echo",
    "--max-turns",
    "10",
    "--json-schema",
    JSON.stringify(outputSchema)
  ];
  const prompt =
    "Call the echo tool with the message 'round-trip-ok'. Then report the exact text the tool returned as the structured output field `echoed`.";

  console.error(`[spike] spawning: claude ${args.join(" ")}`);
  const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(prompt);
  child.stdin.end();

  let stdout = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        console.error(`[stream] type=${ev.type}${ev.subtype ? ` subtype=${ev.subtype}` : ""}`);
      } catch {
        /* partial line */
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const code: number = await new Promise((resolve) => child.on("close", resolve));
  httpServer.close();

  console.error(`[spike] claude exited ${code}`);
  if (stderr.trim()) console.error(`[spike] stderr:\n${stderr.slice(0, 2000)}`);

  // Last complete JSON line with type:"result" carries the envelope.
  const lines = stdout.split("\n").filter((l) => l.trim());
  let resultEnvelope: any = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "result") resultEnvelope = ev;
    } catch {
      /* ignore */
    }
  }

  console.log("=== GATE CHECK ===");
  console.log("tool calls seen by bridge:", JSON.stringify(toolCallsSeen));
  console.log("structured_output:", JSON.stringify(resultEnvelope?.structured_output ?? null));
  console.log("is_error:", resultEnvelope?.is_error ?? "n/a");
  console.log("num_turns:", resultEnvelope?.num_turns ?? "n/a");
  console.log("cost_usd:", resultEnvelope?.total_cost_usd ?? "n/a");

  const pass =
    toolCallsSeen.length >= 1 &&
    toolCallsSeen[0].tool === "echo" &&
    resultEnvelope?.structured_output?.echoed === "echo:round-trip-ok";
  console.log(pass ? "S2 GATE: PASS" : "S2 GATE: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
