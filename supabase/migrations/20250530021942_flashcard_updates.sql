drop policy "Allow students to insert own interaction logs" on "public"."flashcard_interaction_logs";

drop policy "Allow students to see own logs, instructors/graders to see clas" on "public"."flashcard_interaction_logs";

drop policy "Allow deck managers to create cards" on "public"."flashcards";

drop policy "Allow deck managers to delete cards" on "public"."flashcards";

drop policy "Allow deck managers to update cards" on "public"."flashcards";

drop policy "Allow users to view cards in accessible decks" on "public"."flashcards";

drop policy "Allow students to insert own progress" on "public"."student_flashcard_deck_progress";

drop policy "Allow students to see own progress, instructors/graders to see " on "public"."student_flashcard_deck_progress";

drop policy "Allow students to update own progress" on "public"."student_flashcard_deck_progress";

alter table "public"."flashcard_interaction_logs" add column "class_id" bigint not null;

alter table "public"."flashcards" add column "class_id" bigint not null;

alter table "public"."student_flashcard_deck_progress" add column "class_id" bigint not null;

alter table "public"."flashcard_interaction_logs" add constraint "flashcard_interaction_logs_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."flashcard_interaction_logs" validate constraint "flashcard_interaction_logs_class_id_fkey";

alter table "public"."flashcards" add constraint "flashcards_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."flashcards" validate constraint "flashcards_class_id_fkey";

alter table "public"."student_flashcard_deck_progress" add constraint "student_flashcard_deck_progress_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."student_flashcard_deck_progress" validate constraint "student_flashcard_deck_progress_class_id_fkey";

create policy "Allow students to insert own interaction logs"
on "public"."flashcard_interaction_logs"
as permissive
for insert
to authenticated
with check (((student_id = auth.uid()) AND authorizeforclass(class_id) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcard_interaction_logs.deck_id) AND (fd.class_id = flashcard_interaction_logs.class_id)))) AND ((card_id IS NULL) OR (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = flashcard_interaction_logs.card_id) AND (fc.deck_id = flashcard_interaction_logs.deck_id) AND (fc.class_id = flashcard_interaction_logs.class_id)))))));


create policy "Allow students to see own logs, instructors/graders to see clas"
on "public"."flashcard_interaction_logs"
as permissive
for select
to authenticated
using ((((student_id = auth.uid()) OR authorizeforclassgrader(class_id)) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcard_interaction_logs.deck_id) AND (fd.class_id = flashcard_interaction_logs.class_id)))) AND ((card_id IS NULL) OR (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = flashcard_interaction_logs.card_id) AND (fc.class_id = flashcard_interaction_logs.class_id)))))));


create policy "Allow deck managers to create cards"
on "public"."flashcards"
as permissive
for insert
to authenticated
with check (((authorizeforclassgrader(class_id) OR (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.creator_id = auth.uid()) AND (fd.class_id = flashcards.class_id))))) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.class_id = flashcards.class_id))))));


create policy "Allow deck managers to delete cards"
on "public"."flashcards"
as permissive
for delete
to authenticated
using (((authorizeforclassgrader(class_id) OR (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.creator_id = auth.uid()) AND (fd.class_id = flashcards.class_id))))) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.class_id = flashcards.class_id))))));


create policy "Allow deck managers to update cards"
on "public"."flashcards"
as permissive
for update
to authenticated
using (((authorizeforclassgrader(class_id) OR (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.creator_id = auth.uid()) AND (fd.class_id = flashcards.class_id))))) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.class_id = flashcards.class_id))))))
with check (((authorizeforclassgrader(class_id) OR (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.creator_id = auth.uid()) AND (fd.class_id = flashcards.class_id))))) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.class_id = flashcards.class_id))))));


create policy "Allow users to view cards in accessible decks"
on "public"."flashcards"
as permissive
for select
to authenticated
using ((authorizeforclass(class_id) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND (fd.class_id = flashcards.class_id))))));


create policy "Allow students to insert own progress"
on "public"."student_flashcard_deck_progress"
as permissive
for insert
to authenticated
with check (((student_id = auth.uid()) AND authorizeforclass(class_id) AND (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND (fc.class_id = student_flashcard_deck_progress.class_id))))));


create policy "Allow students to see own progress, instructors/graders to see "
on "public"."student_flashcard_deck_progress"
as permissive
for select
to authenticated
using ((((student_id = auth.uid()) OR authorizeforclassgrader(class_id)) AND (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND (fc.class_id = student_flashcard_deck_progress.class_id))))));


create policy "Allow students to update own progress"
on "public"."student_flashcard_deck_progress"
as permissive
for update
to authenticated
using (((student_id = auth.uid()) AND authorizeforclass(class_id) AND (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND (fc.class_id = student_flashcard_deck_progress.class_id))))))
with check (((student_id = auth.uid()) AND authorizeforclass(class_id) AND (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND (fc.class_id = student_flashcard_deck_progress.class_id))))));



