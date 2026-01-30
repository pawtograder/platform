# Pawtograder MCP Server

A Model Context Protocol (MCP) server that provides AI assistants with tools to help TAs support students who are struggling with errors in their programming assignments.

## Architecture

The MCP server is implemented as a **Supabase Edge Function** (`/supabase/functions/mcp-server/`) that:

1. **Authenticates** using long-lived API tokens (JWTs signed with MCP_JWT_SECRET)
2. **Mints** short-lived Supabase JWTs for RLS enforcement
3. **Restricts** access to instructors and graders only
4. **Never exposes** data from the "users" table or "is_private_profile" field

## Authentication Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Request Flow                               │
└─────────────────────────────────────────────────────────────────────────┘

1. USER LOGS INTO DASHBOARD
   Browser ──► Supabase Auth ──► Session established

2. USER CREATES API TOKEN (Dashboard Settings)
   Browser ──► POST /api/mcp-tokens ──► Returns: mcp_eyJhbG...
   (User saves token, shown only once)

3. USER CONFIGURES MCP CLIENT
   Claude Desktop config or environment variable:
   { "headers": { "Authorization": "Bearer mcp_eyJhbG..." } }

4. MCP REQUEST
   ┌────────────────────────────────────────────────────────────────────┐
   │   API Token (mcp_eyJhbG...)                                        │
   │         │                                                          │
   │         ▼                                                          │
   │   ┌──────────────┐                                                 │
   │   │ Verify JWT   │ ◄── MCP_JWT_SECRET                              │
   │   │ (no DB hit)  │     Extract: user_id, scopes, exp               │
   │   └──────────────┘                                                 │
   │         │                                                          │
   │         ▼                                                          │
   │   ┌──────────────┐                                                 │
   │   │ Check        │ ◄── Optional DB lookup for revocation           │
   │   │ Revocation   │                                                 │
   │   └──────────────┘                                                 │
   │         │                                                          │
   │         ▼                                                          │
   │   ┌──────────────┐                                                 │
   │   │ Mint short   │ ◄── SUPABASE_JWT_SECRET                         │
   │   │ Supabase JWT │     60s TTL, cached per user                    │
   │   └──────────────┘                                                 │
   │         │                                                          │
   │         ▼                                                          │
   │   ┌──────────────┐                                                 │
   │   │ Execute Tool │ ◄── RLS enforced via auth.uid()                 │
   │   │ with RLS     │                                                 │
   │   └──────────────┘                                                 │
   └────────────────────────────────────────────────────────────────────┘
```

## Available Tools

### `get_help_request`
Get a help request with full context including:
- Student's question
- Linked assignment (with handout URL)
- Referenced submission details with test results and files
- Latest submission for the student on this assignment
- Conversation messages

### `get_discussion_thread`
Get a discussion thread with:
- Question/topic content
- Assignment context (with handout URL)
- Latest submission for the author
- Replies with staff indicators

### `get_submission`
Get a submission with full grader results including:
- Test outputs and scores
- Build output (stdout/stderr)
- Lint results
- Error information
- All submission files

### `get_submissions_for_student`
Get all submissions for a student on a specific assignment.

### `get_assignment`
Get assignment details including:
- Title and description
- Handout URL (for assignment instructions)
- Due date and points

### `search_help_requests`
Search help requests filtered by assignment or status.

### `search_discussion_threads`
Search discussion threads filtered by assignment, question status, or keyword.

## Environment Variables

### Edge Function Environment

| Variable | Source | Purpose |
|----------|--------|---------|
| `MCP_JWT_SECRET` | Generate (min 32 chars) | Sign/verify MCP API tokens |
| `SUPABASE_JWT_SECRET` | Dashboard → Settings → API | Mint user JWTs for RLS |
| `SUPABASE_URL` | Dashboard | Supabase project URL |
| `SUPABASE_ANON_KEY` | Dashboard | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard | For admin operations |

### Next.js Environment

| Variable | Purpose |
|----------|---------|
| `MCP_JWT_SECRET` | Same secret for creating tokens |

## Token Management

### Creating a Token (Dashboard API)

```bash
POST /api/mcp-tokens
Authorization: <Supabase session cookie>
Content-Type: application/json

{
  "name": "My Claude Desktop Token",
  "scopes": ["mcp:read"],
  "expires_in_days": 90
}
```

Response:
```json
{
  "token": "mcp_eyJhbGciOiJIUzI1NiIs...",
  "metadata": {
    "id": "uuid",
    "name": "My Claude Desktop Token",
    "scopes": ["mcp:read"],
    "expires_at": "2026-04-30T...",
    "created_at": "2026-01-30T..."
  },
  "message": "Token created successfully. Save this token - it will only be shown once!"
}
```

### Listing Tokens

```bash
GET /api/mcp-tokens
Authorization: <Supabase session cookie>
```

### Revoking a Token

```bash
DELETE /api/mcp-tokens/{id}
Authorization: <Supabase session cookie>
```

## Token Scopes

| Scope | Description |
|-------|-------------|
| `mcp:read` | Read-only access to help requests, discussions, submissions |
| `mcp:write` | Create, update, delete operations (future) |

## Client Configuration

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "pawtograder": {
      "url": "https://<project>.supabase.co/functions/v1/mcp-server",
      "headers": {
        "Authorization": "Bearer mcp_eyJhbG..."
      }
    }
  }
}
```

## Database Schema

### `api_tokens` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `user_id` | uuid | FK to auth.users |
| `name` | text | User-provided label |
| `token_id` | text | JWT `jti` claim (unique) |
| `scopes` | text[] | Granted scopes |
| `expires_at` | timestamptz | Token expiry |
| `revoked_at` | timestamptz | Soft delete for revocation |
| `created_at` | timestamptz | Creation timestamp |
| `last_used_at` | timestamptz | Optional usage tracking |

### `revoked_token_ids` Table

Fast lookup table populated by trigger when tokens are revoked.

| Column | Type | Description |
|--------|------|-------------|
| `token_id` | text | Primary key, matches JWT `jti` |
| `revoked_at` | timestamptz | When revoked |

## Privacy Considerations

This server is designed with student privacy in mind:

- **Never exposes the "users" table**: No email addresses or auth identifiers
- **Never exposes "is_private_profile"**: Private profile settings are not leaked
- **Safe profile access**: Only returns name and avatar for display purposes
- **Role verification**: All requests verify instructor/grader access before returning data
- **RLS enforcement**: Uses short-lived Supabase JWTs to enforce row-level security

## Security

| Concern | Approach |
|---------|----------|
| Token storage | Shown once at creation, user stores securely |
| Signing keys | Environment variables, isolated from DB |
| Key rotation | Deploy new key, support both temporarily |
| Scope enforcement | Embedded in JWT, checked before each tool |
| Revocation | DB lookup via revoked_token_ids table |
| RLS guarantee | Short-lived Supabase JWT, no service_role in handlers |

## Development

The Edge Function code is in `/supabase/functions/mcp-server/index.ts`.

Shared utilities are in:
- `/supabase/functions/_shared/MCPAuth.ts` - Authentication utilities
- `/supabase/functions/_shared/SupabaseTypes.d.ts` - Database types

### Local Development

```bash
# Start Supabase locally
supabase start

# Run the edge function locally
supabase functions serve mcp-server --env-file ./supabase/.env.local
```

### Deployment

Edge functions are deployed automatically with Supabase. The function is available at:
```
https://<project>.supabase.co/functions/v1/mcp-server
```
