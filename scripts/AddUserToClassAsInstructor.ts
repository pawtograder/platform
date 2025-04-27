import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { createClient } from "@supabase/supabase-js";
import dotenv from 'dotenv';
dotenv.config({path: '.env.local.staging.priv'});

const courseID = parseInt(process.argv[2]);
const userEmail = process.argv[3];

const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);
async function main() {
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user) {
        console.error("User not found");
        return;
    }
    //Create private profile
    const { data: privateProfile , error: privateProfileError} = await supabase.from('profiles').insert({
        name: user.name,
        class_id: courseID,
        is_private_profile: true,
        avatar_url: "https://api.dicebear.com/9.x/identicon/svg?seed=" + userEmail,
    }).select('id').single();
    if (privateProfileError) {
        console.error("Error creating private profile", privateProfileError);
    }
    //Create public profile
    const { data: publicProfile , error: publicProfileError} = await supabase.from('profiles').insert({
        name: "Anonymous Turtle",
        class_id: courseID,
        avatar_url: "https://api.dicebear.com/9.x/identicon/svg?seed=" + userEmail,
        is_private_profile: false,
    }).select('id').single();
    if (publicProfileError) {
        console.error("Error creating public profile", publicProfileError);
    }
    //Enroll user in class
    const {error: enrollmentError} = await supabase.from('user_roles').insert({
        user_id: user.user_id,
        class_id: courseID,
        role: 'instructor',
        private_profile_id: privateProfile!.id,
        public_profile_id: publicProfile!.id,
    });
    if (enrollmentError) {
        console.error("Error enrolling user", enrollmentError);
    }
}

main();