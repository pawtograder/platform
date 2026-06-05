-- Code-symbol index for submission source files.
--
-- One row per (parsed) submission file holding the heuristically-extracted symbols (classes,
-- functions/methods, fields/variables) as JSONB. Populated server-side at submission ingestion and
-- by the reindex backfill, and read by the grading code viewer to power cross-file "go to
-- definition". Writes happen only via the service role (edge function / ingestion); there is no
-- INSERT/UPDATE/DELETE policy. class_id / profile_id / assignment_group_id are denormalized from
-- submission_files so the SELECT policy can reuse the same access predicate without a join.

create table if not exists "public"."submission_file_symbol_index" (
    "submission_file_id" bigint not null,
    "submission_id" bigint not null,
    "class_id" bigint not null,
    "profile_id" uuid,
    "assignment_group_id" bigint,
    "language" text not null,
    "symbols" jsonb not null default '[]'::jsonb,
    "indexed_at" timestamp with time zone not null default now(),
    constraint submission_file_symbol_index_pkey primary key (submission_file_id),
    constraint submission_file_symbol_index_file_fkey foreign key (submission_file_id) references submission_files(id) on delete cascade,
    constraint submission_file_symbol_index_submission_fkey foreign key (submission_id) references submissions(id) on delete cascade,
    constraint submission_file_symbol_index_class_fkey foreign key (class_id) references classes(id) on delete cascade,
    constraint submission_file_symbol_index_profile_fkey foreign key (profile_id) references profiles(id) on delete set null,
    constraint submission_file_symbol_index_group_fkey foreign key (assignment_group_id) references assignment_groups(id) on delete set null
);

create index if not exists idx_submission_file_symbol_index_submission
    on "public"."submission_file_symbol_index" (submission_id);
create index if not exists idx_submission_file_symbol_index_class
    on "public"."submission_file_symbol_index" (class_id);

alter table "public"."submission_file_symbol_index" enable row level security;

-- Mirrors the submission_files SELECT predicate: graders/instructors of the class, the owning
-- student, or members of the owning assignment group. Inlined onto user_privileges (rather than
-- the authorizefor* helpers) to avoid per-row SECURITY DEFINER function calls, matching the
-- submissions RLS pattern.
create policy "view symbol index for accessible submission files"
    on "public"."submission_file_symbol_index"
    for select
    to public
    using (
        -- owning student (via profile ownership)
        (
            profile_id IN (
                SELECT up.private_profile_id
                FROM public.user_privileges up
                WHERE up.user_id = auth.uid()
                    AND up.private_profile_id IS NOT NULL
            )
        )
        OR
        -- instructors/graders of the class
        (
            class_id IN (
                SELECT up.class_id
                FROM public.user_privileges up
                WHERE up.user_id = auth.uid()
                    AND up.role IN ('instructor','grader')
            )
        )
        OR
        -- members of the owning assignment group
        (
            assignment_group_id IS NOT NULL
            AND assignment_group_id IN (
                SELECT agm.assignment_group_id
                FROM public.assignment_groups_members agm
                JOIN public.user_privileges up ON up.private_profile_id = agm.profile_id
                WHERE up.user_id = auth.uid()
            )
        )
    );
