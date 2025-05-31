create policy "Allow creator or instructor/grader to delete decks"
on "public"."flashcard_decks"
as permissive
for delete
to authenticated
using (((creator_id = auth.uid()) OR authorizeforclassgrader(class_id)));


create policy "Allow creator or instructor/grader to update decks"
on "public"."flashcard_decks"
as permissive
for update
to authenticated
using (((creator_id = auth.uid()) OR authorizeforclassgrader(class_id)))
with check (((creator_id = auth.uid()) OR authorizeforclassgrader(class_id)));


create policy "Allow instructors/graders to create decks"
on "public"."flashcard_decks"
as permissive
for insert
to authenticated
with check ((authorizeforclassgrader(class_id) AND (creator_id = auth.uid())));


create policy "Allow users to view decks in their class"
on "public"."flashcard_decks"
as permissive
for select
to authenticated
using (authorizeforclass(class_id));


create policy "Allow students to insert own interaction logs"
on "public"."flashcard_interaction_logs"
as permissive
for insert
to authenticated
with check (((student_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcard_interaction_logs.deck_id) AND authorizeforclass(fd.class_id)))) AND ((card_id IS NULL) OR (EXISTS ( SELECT 1
   FROM flashcards fc
  WHERE ((fc.id = flashcard_interaction_logs.card_id) AND (fc.deck_id = flashcard_interaction_logs.deck_id)))))));


create policy "Allow students to see own logs, instructors/graders to see clas"
on "public"."flashcard_interaction_logs"
as permissive
for select
to authenticated
using (((student_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcard_interaction_logs.deck_id) AND authorizeforclassgrader(fd.class_id))))));


create policy "Allow deck managers to create cards"
on "public"."flashcards"
as permissive
for insert
to authenticated
with check ((EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND ((fd.creator_id = auth.uid()) OR authorizeforclassgrader(fd.class_id))))));


create policy "Allow deck managers to delete cards"
on "public"."flashcards"
as permissive
for delete
to authenticated
using ((EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND ((fd.creator_id = auth.uid()) OR authorizeforclassgrader(fd.class_id))))));


create policy "Allow deck managers to update cards"
on "public"."flashcards"
as permissive
for update
to authenticated
using ((EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND ((fd.creator_id = auth.uid()) OR authorizeforclassgrader(fd.class_id))))))
with check ((EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND ((fd.creator_id = auth.uid()) OR authorizeforclassgrader(fd.class_id))))));


create policy "Allow users to view cards in accessible decks"
on "public"."flashcards"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM flashcard_decks fd
  WHERE ((fd.id = flashcards.deck_id) AND authorizeforclass(fd.class_id)))));


create policy "Allow students to delete own progress"
on "public"."student_flashcard_deck_progress"
as permissive
for delete
to authenticated
using ((student_id = auth.uid()));


create policy "Allow students to insert own progress"
on "public"."student_flashcard_deck_progress"
as permissive
for insert
to authenticated
with check (((student_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (flashcards fc
     JOIN flashcard_decks fd ON ((fc.deck_id = fd.id)))
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND authorizeforclass(fd.class_id))))));


create policy "Allow students to see own progress, instructors/graders to see "
on "public"."student_flashcard_deck_progress"
as permissive
for select
to authenticated
using (((student_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (flashcards fc
     JOIN flashcard_decks fd ON ((fc.deck_id = fd.id)))
  WHERE ((fc.id = student_flashcard_deck_progress.card_id) AND authorizeforclassgrader(fd.class_id))))));


create policy "Allow students to update own progress"
on "public"."student_flashcard_deck_progress"
as permissive
for update
to authenticated
using ((student_id = auth.uid()))
with check ((student_id = auth.uid()));



