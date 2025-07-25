CREATE TABLE IF NOT EXISTS "public"."emails" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "batch_id" bigint not null,
    "class_id" bigint not null,
    "subject" text not null,
    "body" text not null,
    "cc_emails" jsonb not null,
    "reply_to" text
);

CREATE TABLE IF NOT EXISTS "public"."email_batches" (
   "id" bigint generated by default as identity not null,
   "created_at" timestamp with time zone not null default now(),
   "subject" text not null,
   "body" text not null,
   "class_id" bigint not null,
   "cc_emails" jsonb not null,
   "reply_to" text

);

ALTER TABLE "public"."emails" 
    ADD CONSTRAINT "emails_pkey" PRIMARY KEY ("id");

ALTER TABLE "public"."email_batches" 
    ADD CONSTRAINT "email_batches_pkey" PRIMARY KEY ("id");

ALTER TABLE "public"."email_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emails" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."emails"
    ADD CONSTRAINT "emails_users_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id");

ALTER TABLE "public"."emails"
    ADD CONSTRAINT "emails_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

ALTER TABLE "public"."emails"
    ADD CONSTRAINT "emails_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."email_batches"("id");


ALTER TABLE "public"."email_batches"
    ADD CONSTRAINT "email_batches_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");

create policy "Instructors can view emails"
on "public"."emails"
as permissive
for select
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can create emails"
on "public"."emails"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));

create policy "Instructors can update emails"
on "public"."emails"
as permissive
for update
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can delete emails"
on "public"."emails"
as permissive
for delete
to authenticated
using (authorizeforclassinstructor(class_id));

create policy "Instructors can view email_batches"
on "public"."email_batches"
as permissive
for select
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can create email_batches"
on "public"."email_batches"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));

create policy "Instructors can update email_batches"
on "public"."email_batches"
as permissive
for update
to authenticated
using( authorizeforclassinstructor(class_id));

create policy "Instructors can delete email_batches"
on "public"."email_batches"
as permissive
for delete
to authenticated
using (authorizeforclassinstructor(class_id));


CREATE OR REPLACE FUNCTION "public"."email_notifications"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
   email public.emails%ROWTYPE;
   body_jsonb jsonb;
   subject_jsonb jsonb;
   assignment public.assignments%ROWTYPE;
   private_id uuid;
   assignment_group public.assignment_groups%ROWTYPE;
   net_deadline_change_hours bigint;
   net_deadline_change_minutes bigint;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      body_jsonb := jsonb_build_object(
         'type', 'email',
         'action', 'create',
         'subject', NEW.subject,
         'body', NEW.body,
         'cc_emails', NEW.cc_emails
      );

      IF NEW.reply_to IS NOT NULL THEN
         body_jsonb := body_jsonb || jsonb_build_object('reply_to', NEW.reply_to);
      END IF;

      INSERT INTO notifications (class_id, "subject", body, style, user_id) VALUES 
         (NEW.class_id, to_jsonb(NEW.subject), body_jsonb, 'email', NEW.user_id);
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$$;

ALTER FUNCTION "public"."email_notifications"() OWNER TO "postgres";

CREATE OR REPLACE TRIGGER "email_notifications" AFTER INSERT ON "public"."emails" FOR EACH ROW EXECUTE FUNCTION "public"."email_notifications"();
