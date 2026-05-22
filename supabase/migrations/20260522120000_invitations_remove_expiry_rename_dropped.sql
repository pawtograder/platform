-- #322: Remove the time-based auto-expiry from invitations and rename the
-- "expired" status to "dropped". After this migration:
--   * invitations have no expires_at column and never auto-expire by age
--   * status='dropped' means exactly "removed from the SIS roster"
--     (previously this was overloaded onto the word "expired")
--
-- The function bodies that read expires_at / set status='expired' are redefined
-- in a later migration in this same batch; plpgsql does not validate column
-- references until execution, so dropping the column here is safe.

-- 1) Drop the time-based expiry column and its index.
DROP INDEX IF EXISTS public.idx_invitations_expires_at;
ALTER TABLE public.invitations DROP COLUMN IF EXISTS expires_at;

-- 2) Rename the status value 'expired' -> 'dropped'.
--    Widen the CHECK first so the data UPDATE is legal, then migrate data.
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_status_check;
ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_status_check
  CHECK (status IN ('pending', 'accepted', 'dropped', 'cancelled'));

UPDATE public.invitations SET status = 'dropped' WHERE status = 'expired';

COMMENT ON COLUMN public.invitations.status IS
  'Status of invitation: pending, accepted, dropped (removed from SIS roster), or cancelled';
