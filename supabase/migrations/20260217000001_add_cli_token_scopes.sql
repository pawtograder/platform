-- Migration: Add CLI token scopes to api_tokens table
-- Expands the MCP token system to also support CLI tokens with read/write scopes

-- Drop the existing CHECK constraint and recreate with CLI scopes included
ALTER TABLE public.api_tokens
    DROP CONSTRAINT IF EXISTS valid_scopes;

ALTER TABLE public.api_tokens
    ADD CONSTRAINT valid_scopes CHECK (
        scopes <@ ARRAY['mcp:read', 'mcp:write', 'cli:read', 'cli:write']::TEXT[]
    );

-- Update comments to reflect the expanded scope system
COMMENT ON COLUMN public.api_tokens.scopes IS 'Granted permissions: mcp:read, mcp:write, cli:read, cli:write';
