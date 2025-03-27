CREATE TRIGGER update_github_profile AFTER INSERT ON auth.identities FOR EACH ROW WHEN ((new.provider = 'github'::text)) EXECUTE FUNCTION update_github_profile();

CREATE TRIGGER create_user_ensure_profiles_and_demo AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION user_register_create_demo_account();


create policy "....anyone can read 1va6avm_0"
on "storage"."objects"
as permissive
for select
to anon, authenticated
using ((bucket_id = 'uploads'::text));


create policy "restrict to class 1va6avm_0"
on "storage"."objects"
as permissive
for insert
to public
with check (((bucket_id = 'uploads'::text) AND is_in_class(auth.uid(), (intval(((storage.foldername(name))[1])::character varying))::bigint)));



