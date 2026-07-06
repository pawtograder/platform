-- class_sections is missing an updated_at column (lab_sections has one), yet
-- admin_get_class_sections selects cs.updated_at and admin_update_class_section
-- sets it — so both error with "column cs.updated_at does not exist". Add the
-- column to match lab_sections and fix those RPCs.
ALTER TABLE public.class_sections
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
