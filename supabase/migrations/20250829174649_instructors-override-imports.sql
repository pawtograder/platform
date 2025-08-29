-- Add sis_managed field to invitations table
-- This allows instructors to manually create invitations that won't be expired by SIS sync

-- Only add the column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'invitations' 
    AND column_name = 'sis_managed'
  ) THEN
    ALTER TABLE public.invitations 
    ADD COLUMN sis_managed boolean NOT NULL DEFAULT true;
    
    -- Add comment to explain the field
    COMMENT ON COLUMN public.invitations.sis_managed IS 'If true, invitation is managed by SIS sync and can be expired. If false, invitation was manually created by instructor and should not be expired by SIS sync.';
  END IF;
END $$;

-- Add index for efficient filtering during SIS sync (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename = 'invitations' 
    AND indexname = 'idx_invitations_sis_managed'
  ) THEN
    CREATE INDEX idx_invitations_sis_managed ON public.invitations (sis_managed) WHERE sis_managed = false;
  END IF;
END $$;

-- Update the create_invitation function to accept sis_managed parameter
-- First, find the existing function and recreate it with the new parameter
DROP FUNCTION IF EXISTS public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text,
  p_name text,
  p_invited_by uuid,
  p_class_section_id bigint,
  p_lab_section_id bigint
);

CREATE OR REPLACE FUNCTION public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_invited_by uuid DEFAULT NULL,
  p_class_section_id bigint DEFAULT NULL,
  p_lab_section_id bigint DEFAULT NULL,
  p_sis_managed boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation_id bigint;
  v_expires_at timestamp with time zone;
BEGIN
  -- Set expiration date (30 days from now)
  v_expires_at := NOW() + INTERVAL '30 days';
  
  -- Insert the invitation
  INSERT INTO public.invitations (
    class_id,
    role,
    sis_user_id,
    email,
    name,
    invited_by,
    class_section_id,
    lab_section_id,
    sis_managed,
    status,
    expires_at,
    created_at,
    updated_at
  ) VALUES (
    p_class_id,
    p_role,
    p_sis_user_id,
    p_email,
    p_name,
    p_invited_by,
    p_class_section_id,
    p_lab_section_id,
    p_sis_managed,
    'pending',
    v_expires_at,
    NOW(),
    NOW()
  ) RETURNING id INTO v_invitation_id;
  
  RETURN v_invitation_id;
END;
$$;
