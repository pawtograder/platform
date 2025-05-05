import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { readFile } from "fs/promises";
import { parse } from "csv-parse";
import { createReadStream } from "fs";
import { CanvasApi } from "@kth/canvas-api";
import dotenv from "dotenv";

dotenv.config({ path: "./supabase/functions/.env" });
dotenv.config({ path: "./.env.local.prod" });

/**
 * This script connects to Canvas and finds users that are not in Pawtograder, exporting a CSV of the users that are missing.
 */
const COURSE_ID = 8;
function getCanvas(id: number) {
    const canvas_api_url = process.env[`CANVAS_API_URL_${id}`] || process.env.CANVAS_API_URL;
    const canvas_api_key = process.env[`CANVAS_API_KEY_${id}`] || process.env.CANVAS_API_KEY;
    return new CanvasApi(canvas_api_url!, canvas_api_key!);
}

const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

let nameGenerationNouns: string[] = [];
let nameGenerationAdjectives: string[] = [];
async function generateRandomName(supabase: SupabaseClient<Database>) {
    if (nameGenerationNouns.length === 0) {
        const { data: words, error: wordsError } = await supabase.from('name_generation_words').select('*');
        if (wordsError) {
            console.error(wordsError);
            throw new Error('Error getting words from name_generation_words');
        }
        if (!words) {
            throw new Error('No words found in name_generation_words');
        }
        nameGenerationAdjectives = words.filter(word => word.is_adjective).map(word => word.word);
        nameGenerationNouns = words.filter(word => word.is_noun).map(word => word.word);
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
        canvas_section_id?: number,
        class_section_id?: number,
        time_zone?: string,
        name: string,
        sortable_name?: string,
        short_name?: string,
        avatar_url?: string,
    }, role: Database['public']['Enums']['app_role']) {
    let userId = user.existing_user_id;
    if(!user.primary_email) {
        console.error(`No email found for user ${user.name}`);
        console.error(JSON.stringify(user, null, 2));
        throw new Error('No email found for user ' + user.name);
    }
    if (!userId) {
        console.log("Creating user", user.primary_email);
        const newUser = await supabase.auth.admin.createUser({
            email: user.primary_email,
        });
        if (newUser.error) {
            console.error(newUser.error);
            throw new Error('Error creating user');
        }
        console.log("Created user", newUser);
        userId = newUser.data.user!.id;
    }
    else {
        //Check and see if there is already a profile for this user
        const { data: existingRole } = await supabase.from('user_roles').select('*')
            .eq('user_id', userId)
            .eq('class_id', courseId).single();
        if (existingRole && user.canvas_id) {
            console.log("WARN: User already has a role in class", courseId, "user_id", userId);
            console.log("Adding Canvas Link")
            const {error: updateError} = await supabase.from('user_roles').update({
                canvas_id: user.canvas_id,
                class_section_id: user.class_section_id,
            }).eq('id', existingRole.id);
            if (updateError) {
                throw new Error('Error updating user role');
            }
            return;
        }
    }

    console.log("Creating private profile in class ", courseId, "for user", user.name);

    let avatar_url = user.avatar_url;
    if(!avatar_url || avatar_url === 'https://northeastern.instructure.com/images/messages/avatar-50.png') {
        avatar_url = `https://api.dicebear.com/9.x/identicon/svg?seed=${user.name}`;
    }
    // Create the private profile
    const { data: privateProfile } = await supabase.from('profiles').insert({
        name: user.name,
        sortable_name: user.sortable_name,
        short_name: user.short_name,
        avatar_url: avatar_url,
        class_id: courseId,
        is_private_profile: true,
    }).select('id').single();

    // Create the public profile
    const publicName = await generateRandomName(supabase);
    const { data: publicProfile } = await supabase.from('profiles').insert({
        name: publicName,
        avatar_url: `https://api.dicebear.com/9.x/identicon/svg?seed=${publicName}`,
        class_id: courseId,
        is_private_profile: false,
    }).select('id').single();

    // Add the role
    const {error: insertError} = await supabase.from('user_roles').insert({
        role: role,
        class_id: courseId,
        user_id: userId,
        private_profile_id: privateProfile!.id,
        public_profile_id: publicProfile!.id,
        canvas_id: user.canvas_id,
        class_section_id: user.class_section_id,
    });
    if (insertError) {
        console.error(insertError);
        throw new Error('Error inserting user role');
    }
}

async function main() {
    const canvas = getCanvas(COURSE_ID);
    const allUsers = await supabase.auth.admin.listUsers({
        perPage: 10000
      });
    const csv = createReadStream('3500-fix-enrollments.csv').pipe(parse({
        columns: true,
        skip_empty_lines: true,
    })) as AsyncIterable<{
        Name: string;
        Email: string;
        Role: string;
        'Canvas ID': string;
        'Canvas Section ID': string;
        'Canvas Course ID': string;
    }>;
    const { data: course } = await supabase.from("classes").select("*, class_sections(*)").eq(
        "id",
        COURSE_ID,
      ).single();
    for await (const record of csv) {
        const user = allUsers.data!.users.find((dbUser) =>
          record.Email === dbUser.email
        );
        const classSection = course!.class_sections.find(section => section.canvas_course_section_id === parseInt(record['Canvas Section ID']));
        await createUserInClass(supabase, COURSE_ID, {
            existing_user_id: user?.id,
            primary_email: record.Email,
            name: record.Name,
            canvas_id: parseInt(record['Canvas ID']),
            canvas_course_id: parseInt(record['Canvas Course ID']),
            canvas_section_id: parseInt(record['Canvas Section ID']),
            class_section_id: classSection?.id,
            ...user,
          }, record.Role as Database['public']['Enums']['app_role']);
    }
}
main();