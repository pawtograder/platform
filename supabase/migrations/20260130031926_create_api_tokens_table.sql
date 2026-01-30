-- Migration: Create api_tokens table for MCP server authentication
-- This table stores metadata for API tokens used by MCP clients
-- The tokens themselves are JWTs that don't need to be stored

-- Create the api_tokens table
CREATE TABLE IF NOT EXISTS public.api_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_id TEXT NOT NULL UNIQUE, -- JWT jti claim for revocation lookup
    scopes TEXT[] NOT NULL DEFAULT ARRAY['mcp:read'],
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ, -- Soft delete for revocation
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,

    CONSTRAINT valid_scopes CHECK (
        scopes <@ ARRAY['mcp:read', 'mcp:write']::TEXT[]
    )
);

-- Create index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON public.api_tokens(user_id);

-- Create index for token_id lookups (revocation checks)
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_id ON public.api_tokens(token_id);

-- Create the revoked_token_ids table for fast revocation checks
CREATE TABLE IF NOT EXISTS public.revoked_token_ids (
    token_id TEXT PRIMARY KEY,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Function to add token_id to revoked_token_ids when api_tokens.revoked_at is set
CREATE OR REPLACE FUNCTION public.handle_api_token_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        INSERT INTO public.revoked_token_ids (token_id, revoked_at)
        VALUES (NEW.token_id, NEW.revoked_at)
        ON CONFLICT (token_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

-- Trigger to populate revoked_token_ids
DROP TRIGGER IF EXISTS on_api_token_revoked ON public.api_tokens;
CREATE TRIGGER on_api_token_revoked
    AFTER UPDATE ON public.api_tokens
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_api_token_revocation();

-- RLS policies for api_tokens
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

-- Users can view their own tokens
CREATE POLICY "Users can view own tokens"
    ON public.api_tokens
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own tokens
CREATE POLICY "Users can create own tokens"
    ON public.api_tokens
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update (revoke) their own tokens
CREATE POLICY "Users can revoke own tokens"
    ON public.api_tokens
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own tokens
CREATE POLICY "Users can delete own tokens"
    ON public.api_tokens
    FOR DELETE
    USING (auth.uid() = user_id);

-- Instructors/graders only check (uses the custom_access_token_hook to verify roles)
-- This is enforced at the edge function level, not RLS

-- Grant necessary permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_tokens TO authenticated;
GRANT SELECT ON public.revoked_token_ids TO authenticated;

-- Add comments
COMMENT ON TABLE public.api_tokens IS 'Stores metadata for MCP API tokens (tokens are JWTs, not stored here)';
COMMENT ON COLUMN public.api_tokens.token_id IS 'JWT jti claim for revocation lookup';
COMMENT ON COLUMN public.api_tokens.scopes IS 'Granted permissions: mcp:read, mcp:write';
COMMENT ON TABLE public.revoked_token_ids IS 'Fast lookup table for revoked token IDs';
