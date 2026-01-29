# Pawtograder MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with tools to help TAs support students who are struggling with errors in their programming assignments.

## Features

- **Supabase OAuth Authentication**: Uses pre-registered OAuth client for secure authentication
- **Role-Based Access Control**: Restricted to instructors and graders only
- **Privacy Protection**: Never exposes data from the "users" table or "is_private_profile" field
- **Comprehensive Context**: Provides access to help requests, discussion threads, submissions, and test results

## Available Tools

### `get_help_request`
Get a help request with full context including:
- Student's question
- Linked assignment (with handout URL)
- Submission details
- Conversation messages

### `get_discussion_thread`
Get a discussion thread with:
- Question/topic content
- Assignment context (with handout URL)
- Replies with staff indicators

### `get_submission`
Get a submission with full grader results including:
- Test outputs
- Build output (stdout/stderr)
- Lint results
- Error information

### `get_submissions_for_student`
Get all submissions for a student on a specific assignment to track their progress.

### `get_assignment`
Get assignment details including:
- Title and description
- Handout URL (for assignment instructions)
- Due date and points

### `search_help_requests`
Search help requests filtered by assignment or status.

### `search_discussion_threads`
Search discussion threads filtered by assignment, question status, or keyword.

## Setup

### Environment Variables

```bash
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
MCP_PORT=3100  # optional, defaults to 3100
MCP_HOST=0.0.0.0  # optional
```

### Installation

```bash
cd packages/mcp-server
npm install
```

### Running

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Authentication

The server uses Supabase OAuth for authentication. Clients must include a valid Supabase access token in the Authorization header:

```
Authorization: Bearer <supabase_access_token>
```

The token must belong to a user who has an instructor or grader role in at least one class.

## API Endpoints

### POST /mcp
The main MCP protocol endpoint. Accepts MCP JSON-RPC requests with Bearer token authentication.

### GET /health
Health check endpoint. Returns `{ status: "ok", service: "pawtograder-mcp-server" }`.

### GET /auth/callback
OAuth callback endpoint for completing the OAuth flow.

## Client Integration

To use this MCP server from an AI assistant:

1. Obtain a Supabase access token through OAuth
2. Connect to the MCP server using the Streamable HTTP transport
3. Include the access token in all requests
4. Use the available tools to fetch context for helping students

Example MCP client configuration:
```json
{
  "mcpServers": {
    "pawtograder": {
      "url": "http://localhost:3100/mcp",
      "transport": "streamableHttp",
      "headers": {
        "Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}"
      }
    }
  }
}
```

## Privacy Considerations

This server is designed with student privacy in mind:

- **Never exposes the "users" table**: No email addresses or auth identifiers
- **Never exposes "is_private_profile"**: Private profile settings are not leaked
- **Safe profile access**: Only returns name and avatar for display purposes
- **Role verification**: All requests verify instructor/grader access before returning data

## Launching from Help Request or Discussion

The MCP server is designed to be invoked when a TA needs AI assistance while helping a student. The typical flow is:

1. TA views a help request or discussion thread
2. TA clicks "Get AI Help" button
3. Frontend opens MCP client with pre-filled context:
   - `help_request_id` and `class_id` for help requests
   - `thread_id` and `class_id` for discussions
4. AI assistant uses the appropriate tool to fetch full context
5. AI assistant helps TA understand and resolve the student's issue
