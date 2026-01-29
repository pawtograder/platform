/**
 * Pawtograder MCP Server - Main Entry Point
 *
 * This server provides AI assistants with tools to help TAs support students
 * who are struggling with errors in their programming assignments.
 *
 * Features:
 * - Supabase OAuth authentication (uses pre-registered OAuth client)
 * - Restricted to instructors and graders only
 * - Never exposes data from the "users" table or "is_private_profile" field
 * - Provides context for help requests, discussion threads, and submissions
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { authenticateRequest } from "./auth.js";

const PORT = process.env.MCP_PORT || 3100;
const HOST = process.env.MCP_HOST || "0.0.0.0";

const app = express();
app.use(express.json());

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "pawtograder-mcp-server" });
});

// MCP endpoint - handles all MCP protocol messages
app.post("/mcp", async (req, res) => {
  try {
    // Authenticate the request
    const { supabase, userId, roles } = await authenticateRequest(
      req.headers.authorization
    );

    // Create a new MCP server instance for this request
    const server = createMcpServer();

    // Create the transport with the context
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${userId}-${Date.now()}`,
    });

    // Set the context that will be passed to tool handlers
    const context = { supabase, userId, roles };

    // Connect the server to the transport
    await server.connect(transport);

    // Handle the request
    // The transport will parse the MCP request and return the response
    const mcpRequest = req.body;

    // Inject context into the request for tool handlers
    if (mcpRequest.params) {
      mcpRequest.params._context = context;
    }

    // Process through the transport
    const response = await transport.handleRequest(mcpRequest, {
      context,
    });

    res.json(response);
  } catch (error) {
    console.error("MCP request error:", error);

    // Return error in MCP format
    res.status(error instanceof Error && error.message.includes("Access denied") ? 403 : 401).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error",
      },
      id: req.body?.id || null,
    });
  }
});

// OAuth callback endpoint for Supabase OAuth flow
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }

  // This callback is for clients that need to complete OAuth flow
  // The actual token exchange should be handled by the client application
  // We just redirect back to the client with the code
  const redirectUri = state ? decodeURIComponent(state as string) : "/";
  res.redirect(`${redirectUri}?code=${code}`);
});

// Start the server
app.listen(Number(PORT), HOST, () => {
  console.log(`Pawtograder MCP Server running on http://${HOST}:${PORT}`);
  console.log("Available endpoints:");
  console.log("  POST /mcp - MCP protocol endpoint (requires Bearer token)");
  console.log("  GET /health - Health check");
  console.log("  GET /auth/callback - OAuth callback");
});

export { app };
