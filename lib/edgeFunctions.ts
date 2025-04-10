import { Database } from "@/utils/supabase/SupabaseTypes";
import { createClient, FunctionsHttpError, SupabaseClient } from "@supabase/supabase-js";
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

export async function repositoriesForClass(params: FunctionTypes.ListReposRequest, supabase: SupabaseClient<Database>): Promise<ListReposResponse> {
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
    return JSON.parse(data) as { content: any };
}
export async function githubRepoConfigureWebhook(params: FunctionTypes.GithubRepoConfigureWebhookRequest, supabase: SupabaseClient<Database>) {
    const { data, error } = await supabase.functions.invoke("github-repo-configure-webhook", {
        body: params,
    });
    return JSON.parse(data) as { message: string };
}
export async function enrollmentAdd(params: FunctionTypes.AddEnrollmentRequest, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("enrollments-add", {
        body: params,
    });
    const {error} = data as FunctionTypes.GenericResponse;
    if(error){
        throw new Error(error.message + ": " + error.details);
    }
}
export async function assignmentGroupLeave(params: {assignment_id: number}, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-leave", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { message: string };
}
export async function assignmentGroupApproveRequest(params: {join_request_id: number, course_id: number}, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-approve-request", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { message: string };
}
export async function assignmentGroupCreate(params: FunctionTypes.AssignmentGroupCreateRequest, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-create", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }

}
export async function autograderSyncStaffTeam(params: {course_id: number}, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("autograder-sync-staff-team", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { };
}
export async function assignmentGroupJoin(params: FunctionTypes.AssignmentGroupJoinRequest, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-join", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { message: string, joined_group: boolean };
}
export async function assignmentGroupCopyGroupsFromAssignment(params: FunctionTypes.AssignmentGroupCopyGroupsFromAssignmentRequest, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-copy-groups-from-assignment", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { };
}
export async function assignmentGroupInstructorMoveStudent(params: FunctionTypes.AssignmentGroupInstructorMoveStudentRequest, supabase: SupabaseClient<Database>) {
    const { data} = await supabase.functions.invoke("assignment-group-instructor-move-student", {
        body: params,
    });
    const { error } = data as FunctionTypes.GenericResponse;
    if (error) {
        throw new EdgeFunctionError(error);
    }
    return data as { };
}
export async function activateSubmission(params: {submission_id: number}, supabase: SupabaseClient<Database>) {
    const ret = await supabase.rpc("submission_set_active", {
        _submission_id: params.submission_id,
    });
    if(ret.data){
        return true;
    }
    throw new EdgeFunctionError({details: "Failed to activate submission", message: "Failed to activate submission", recoverable: false});
}
export class EdgeFunctionError extends Error {
    details: string;
    recoverable: boolean;
    
    constructor({details, message, recoverable}: {details: string, message: string, recoverable: boolean}) {
        super(message);
        this.details = details;
        this.recoverable = recoverable;
    }
}