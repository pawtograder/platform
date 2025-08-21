-- Fix duplicate type creation errors without modifying existing migrations
DROP TABLE IF EXISTS public.notification_preferences;
DROP TYPE IF EXISTS public.email_digest_frequency;
DROP TYPE IF EXISTS public.notification_type;