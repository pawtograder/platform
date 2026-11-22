-- #1010: the Emailer (Course Settings > Emailer) follows the send_announcements capability.
--
-- Why: sending email to a class needed an instructor, so no TA role could be given it. Now one
-- capability decides, in the database and on the screen, and an instructor can turn it on for a
-- custom role such as a Head TA.
--
-- What:
--   1. New capability send_announcements, on the default instructor role of every class. It isn't
--      on the default grader role or on custom roles: graders couldn't send email before, so no
--      one gains or loses access.
--   2. Reading, creating, changing and deleting email_batches and emails needs send_announcements
--      in the row's class. Reading moves too: the Emailer reads a new batch back to get its id.
--   3. A new or changed email must go to someone enrolled in its class, and its batch must belong
--      to the same class. Before, an instructor could write an email row for any user, which the
--      email_notifications() trigger then turned into a notification for that user. This limits the
--      recipient only: cc_emails and reply_to can be any address, as the Emailer allows.
--
-- Not changed: the email_notifications() trigger, and discussion topics (they stay
-- instructor-only; moderate_discussion comes later).
--
-- Safe to run again: every policy is dropped before it is created, and the inserts skip rows that
-- exist.

-- ---------------------------------------------------------------------------
-- 1. The capability, on every default instructor role
-- ---------------------------------------------------------------------------

INSERT INTO public.capabilities (name, description)
VALUES ('send_announcements', 'Send emails to the class from the Emailer')
ON CONFLICT (name) DO NOTHING;

-- New classes get it from seed_default_class_roles(), which gives the instructor role every
-- capability. Existing classes need it added here.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT cr.id, 'send_announcements'
FROM public.class_roles cr
WHERE cr.default_for = 'instructor'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. email_batches
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors can view email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Instructors can create email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Instructors can update email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Instructors can delete email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Announcement senders can view email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Announcement senders can create email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Announcement senders can update email_batches" ON public.email_batches;
DROP POLICY IF EXISTS "Announcement senders can delete email_batches" ON public.email_batches;

CREATE POLICY "Announcement senders can view email_batches" ON public.email_batches
  FOR SELECT TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));

CREATE POLICY "Announcement senders can create email_batches" ON public.email_batches
  FOR INSERT TO authenticated
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));

CREATE POLICY "Announcement senders can update email_batches" ON public.email_batches
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));

CREATE POLICY "Announcement senders can delete email_batches" ON public.email_batches
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));

-- ---------------------------------------------------------------------------
-- 3. emails: the same, plus the recipient and the batch must be in the email's class
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Instructors can view emails" ON public.emails;
DROP POLICY IF EXISTS "Instructors can create emails" ON public.emails;
DROP POLICY IF EXISTS "Instructors can update emails" ON public.emails;
DROP POLICY IF EXISTS "Instructors can delete emails" ON public.emails;
DROP POLICY IF EXISTS "Announcement senders can view emails" ON public.emails;
DROP POLICY IF EXISTS "Announcement senders can create emails" ON public.emails;
DROP POLICY IF EXISTS "Announcement senders can update emails" ON public.emails;
DROP POLICY IF EXISTS "Announcement senders can delete emails" ON public.emails;

CREATE POLICY "Announcement senders can view emails" ON public.emails
  FOR SELECT TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));

-- The caller holds send_announcements in the class, so their own RLS lets them read the class's
-- user_roles and email_batches rows these checks look at.
CREATE POLICY "Announcement senders can create emails" ON public.emails
  FOR INSERT TO authenticated
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('send_announcements'))
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = emails.user_id
        AND ur.class_id = emails.class_id
    )
    AND EXISTS (
      SELECT 1 FROM public.email_batches eb
      WHERE eb.id = emails.batch_id
        AND eb.class_id = emails.class_id
    )
  );

CREATE POLICY "Announcement senders can update emails" ON public.emails
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')))
  WITH CHECK (
    class_id IN (SELECT public.user_class_ids_with_capability('send_announcements'))
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = emails.user_id
        AND ur.class_id = emails.class_id
    )
    AND EXISTS (
      SELECT 1 FROM public.email_batches eb
      WHERE eb.id = emails.batch_id
        AND eb.class_id = emails.class_id
    )
  );

CREATE POLICY "Announcement senders can delete emails" ON public.emails
  FOR DELETE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('send_announcements')));
