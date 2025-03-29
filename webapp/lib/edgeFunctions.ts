import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as FunctionTypes from "@/supabase/functions/_shared/FunctionTypes.js";
import { CreateMeetingCommandOutput, CreateAttendeeCommandOutput } from "@aws-sdk/client-chime-sdk-meetings";
import { ListFilesResponse, ListReposResponse } from "@/components/github/GitHubTypes";
export async function autograderCreateReposForStudent(supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("autograder-create-repos-for-student");
}

export async function autograderCreateAssignmentRepos(params: FunctionTypes.AssignmentCreateAllReposRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("assignment-create-all-repos", {
        body: params,
    });
    return JSON.parse(data) as { message: string };
}
export async function liveMeetingForHelpRequest(params: FunctionTypes.LiveMeetingForHelpRequestRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("live-meeting-for-help-request", {
        body: params,
    });
    return JSON.parse(data) as { Meeting: CreateMeetingCommandOutput, Attendee: CreateAttendeeCommandOutput };
}

export async function repositoriesForClass(params: FunctionTypes.ListReposRequest, supabase: SupabaseClient<Database>) : Promise<ListReposResponse>{
    const { data, error } = await supabase.functions.invoke("repositories-list", {
        body: params,
    });
    return JSON.parse(data) as ListReposResponse;
}

export async function repositoryListFiles(params: FunctionTypes.ListFilesRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("repository-list-files", {
        body: params,
    });
    return JSON.parse(data) as FunctionTypes.FileListing[];
}
export async function repositoryGetFile(params: FunctionTypes.GetFileRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("repository-get-file", {
        body: params,
    });
    return JSON.parse(data) as {content: any};
}
export async function enrollmentAdd(params: FunctionTypes.AddEnrollmentRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("enrollments-add", {
        body: params,
    });
}
