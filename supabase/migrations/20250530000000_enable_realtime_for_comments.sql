-- Enable realtime for submission comments tables
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."submission_comments";
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."submission_artifact_comments";
