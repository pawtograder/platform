import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

let nameGenerationNouns: string[] = [];
let nameGenerationAdjectives: string[] = [];
async function generateRandomName(supabase: SupabaseClient<Database>){
    if(nameGenerationNouns.length === 0) {
        const { data: words, error: wordsError } = await supabase.from('name_generation_words').select('*');
        if(wordsError) {
            console.error(wordsError);
            throw new Error('Error getting words from name_generation_words');
        }
        if(!words) {
            throw new Error('No words found in name_generation_words');
        }
        nameGenerationAdjectives = words.filter(word=>word.is_adjective).map(word=>word.word);
        nameGenerationNouns = words.filter(word=>word.is_noun).map(word=>word.word);
    }
    const adjective = nameGenerationAdjectives[Math.floor(Math.random() * nameGenerationAdjectives.length)];
    const noun = nameGenerationNouns[Math.floor(Math.random() * nameGenerationNouns.length)];
    const number = Math.floor(Math.random() * 1000);
    return `${adjective}-${noun}-${number}`;
}
export async function createUserInClass(supabase: SupabaseClient<Database>, courseId: number,
  user: {
      existing_user_id?: string,
      primary_email: string,
      canvas_id?: number,
      canvas_course_id?: number,
      time_zone?: string,
      name: string,
      sortable_name?: string,
      short_name?: string,
      avatar_url?: string,
  }, role: Database['public']['Enums']['app_role'] ) {
      let userId = user.existing_user_id;
      if(!userId) {
          const newUser = await supabase.auth.admin.createUser({
              email: user.primary_email,
          });
          console.log("Created user", newUser);
          userId = newUser.data.user!.id;
      } 

      // Create the private profile
      const {data: privateProfile} = await supabase.from('profiles').insert({
          name: user.name,
          sortable_name: user.sortable_name,
          short_name: user.short_name,
          avatar_url: user.avatar_url,
          class_id: courseId,
      }).select('id').single();

      // Create the public profile
      const publicName = await generateRandomName(supabase);
      const {data: publicProfile} = await supabase.from('profiles').insert({
          name: publicName,
          avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${publicName}`,
          class_id: courseId,
      }).select('id').single();

      // Add the role
      await supabase.from('user_roles').insert({
          role: role,
          class_id: courseId,
          user_id: userId,
          private_profile_id: privateProfile!.id,
          public_profile_id: publicProfile!.id,
      });
  }
