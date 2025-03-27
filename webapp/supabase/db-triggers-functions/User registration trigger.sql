create or replace function user_register_create_demo_account () RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER as $func$
declare
   existing_profile boolean;
   existing_public_profile boolean;
   new_public_profile_id uuid;
   new_private_profile_id uuid;
   demo_class_id int8;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT EXISTS(SELECT 1 from public.users where user_id=NEW.id) INTO existing_profile;
      if not existing_profile then
         INSERT INTO public.users (user_id) VALUES (NEW.id);
      end if;
      SELECT id FROM public.classes WHERE is_demo LIMIT 1 INTO demo_class_id;
      if demo_class_id is not null then
        INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
            (NEW.email, 'https://api.dicebear.com/9.x/identicon/svg?seed=' || NEW.email, demo_class_id) RETURNING id into new_private_profile_id;

        INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
            (public.generate_anon_name(),'https://api.dicebear.com/9.x/identicon/svg?seed='||public.generate_anon_name(), demo_class_id) RETURNING id into new_public_profile_id; 

        IF NEW.email LIKE '%instructor%' THEN
            INSERT INTO public.user_roles (user_id, class_id, role, public_profile_id, private_profile_id) VALUES (NEW.id, demo_class_id, 'instructor', new_public_profile_id, new_private_profile_id);
        ELSE    
            INSERT INTO public.user_roles (user_id, class_id, role, public_profile_id, private_profile_id) VALUES (NEW.id, demo_class_id, 'student', new_public_profile_id, new_private_profile_id);
        END IF;
      end if;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$func$;

create
or REPLACE TRIGGER create_user_ensure_profiles_and_demo
after INSERT on auth.users for EACH row
execute FUNCTION user_register_create_demo_account ();

create or replace function get_user_id_by_email (email TEXT) RETURNS table (id uuid) SECURITY definer as $$
BEGIN
  RETURN QUERY SELECT au.id FROM auth.users au WHERE au.email = $1;
END;
$$ LANGUAGE plpgsql;