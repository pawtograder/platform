import { createClient, User } from "@supabase/supabase-js";
import { sluggify } from "@theredhead/core-functions";
import { Body, Get, Path, Post, Route, Security } from "tsoa";
import { CanvasController } from "./CanvasController.js";
import GitHubController from "../GitHubController.js";
import { Database } from "../SupabaseTypes.js";
import { UserVisibleError, NotFoundError } from "../InternalTypes.js";

type NameGenerationWord = Database['public']['Tables']['name_generation_words']['Row'];
const supabase = createClient<Database>(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
@Route('/api/instructor/')
@Security('supabase', ['instructor'])
export class CourseAdminController {
    constructor() {
    }

    @Post('/{courseId}/assignment/{assignmentId}/repositories')
    async createAssignmentRepositories(@Path() courseId: number, @Path() assignmentId: number) {
        // Get the assignment from supabase
        const { data: assignment } = await supabase.from('assignments')
            .select('*, classes(slug,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))') // , classes(canvas_id), user_roles(user_id)')
            .eq('id', assignmentId)
            .lte('release_date', new Date().toISOString())
            .eq('class_id', courseId).single();
        if (!assignment) {
            throw new Error('Assignment not found');
        }
        // Select all existing repos for the assignment
        const { data: existingRepos } = await supabase.from('repositories').select('*').eq('assignment_id', assignmentId);
        // Find repos that need to be created
        const reposToCreate = assignment.classes!.user_roles.filter(userRole =>
            userRole.users.github_username &&
            !existingRepos?.find(repo => repo.profile_id === userRole.profiles!.id));

        const createRepo = async (uid: string, name: string, github_username: string) => {
            const repoName = `${assignment.classes?.slug}-${assignment.slug}-${github_username}`;
            console.log(`Creating repo ${repoName} for ${name}`);
            if (!assignment.template_repo) {
                console.log(`No template repo for assignment ${assignment.id}`);
                return;
            }
            await GitHubController.getInstance().createRepo('autograder-dev', repoName, assignment.template_repo, github_username);
            const {error} = await supabase.from('repositories').insert({
                profile_id: uid,
                assignment_id: assignmentId,
                repository: 'autograder-dev/' + repoName,
                class_id: courseId,
            });
            if (error) {
                console.error(error);
            }
        }
        await Promise.all(reposToCreate.map(async (userRole) => createRepo(userRole.profiles!.id, userRole.profiles!.name!, userRole.users!.github_username!)));


    }

    private _nameGenerationNouns: string[] = [];
    private _nameGenerationAdjectives: string[] = [];
    async generateRandomName(){
        if(this._nameGenerationNouns.length === 0) {
            const { data: words, error: wordsError } = await supabase.from('name_generation_words').select('*');
            if(wordsError) {
                console.error(wordsError);
                throw new Error('Error getting words from name_generation_words');
            }
            if(!words) {
                throw new Error('No words found in name_generation_words');
            }
            this._nameGenerationAdjectives = words.filter(word=>word.is_adjective).map(word=>word.word);
            this._nameGenerationNouns = words.filter(word=>word.is_noun).map(word=>word.word);
        }
        const adjective = this._nameGenerationAdjectives[Math.floor(Math.random() * this._nameGenerationAdjectives.length)];
        const noun = this._nameGenerationNouns[Math.floor(Math.random() * this._nameGenerationNouns.length)];
        const number = Math.floor(Math.random() * 1000);
        return `${adjective}-${noun}-${number}`;
    }

    async createUserInClass(courseId: number,
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
        const publicName = await this.generateRandomName();
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
    @Post('/{courseId}/enrollments')
    async addEnrollment(@Path() courseId: number, @Body() enrollment: {
        email: string,
        name: string,
        role: Database['public']['Enums']['app_role'],
    }) {
        //First look to see if the user already exists
        const { data: existingUser } = await supabase.rpc("get_user_id_by_email",{
            email: enrollment.email
        }).single();
        await this.createUserInClass(courseId, {
            primary_email: enrollment.email,
            name: enrollment.name,
            existing_user_id: existingUser?.id,
        }, enrollment.role);
    }
    @Post('/{courseId}/canvas/enrollments')
    async syncEnrollments(courseId: number) {
        const canvasController = new CanvasController();
        const { data: course } = await supabase.from('classes').select('*').eq('id', courseId).single();
        const canvasEnrollments = await canvasController.getEnrollments(course!.canvas_id!);
        const supabaseEnrollments = await supabase.from('user_roles').select('*').eq('class_id', courseId);
        // Find the enrollments that need to be added
        // const newEnrollments = canvasEnrollments.filter(canvasEnrollment => !supabaseEnrollments.data!.find(supabaseEnrollment => supabaseEnrollment.sis_user_id === canvasEnrollment.sis_user_id));
        const newEnrollments = canvasEnrollments;
        const allUsers = await supabase.auth.admin.listUsers();
        const newProfiles = await Promise.all(newEnrollments.map(async (enrollment) => {
            const user = await canvasController.getUser(enrollment.user_id);
            // Does the user already exist in supabase?
            const existingUser = allUsers.data!.users.find(dbUser => user.primary_email === dbUser.email);
            const dbRoleForCanvasRole = (role: string): Database['public']['Enums']['app_role'] => {
                switch (role) {
                    case 'StudentEnrollment':
                        return 'student';
                    case 'TeacherEnrollment':
                        return 'instructor';
                    case 'TaEnrollment':
                        return 'grader';
                    case 'ObserverEnrollment':
                        return 'student';
                    default:
                        return 'student';
                }
            }
            await this.createUserInClass(courseId,{
                existing_user_id: existingUser?.id,
                ...user
            }, dbRoleForCanvasRole(enrollment.role));
        }));
    }

    @Get('/{courseId}/template-repos')
    async getTemplateRepos(@Path() courseId: number) {
        // Get course from supabase
        const { data: course } = await supabase.from('classes').select('*').eq('id', courseId).single();
        if (!course) {
            throw new Error('Course not found');
        }

        // Fetch repos from GitHub
        const repos = await GitHubController.getInstance().getRepos(course);
        const templateRepos = repos.filter((repo) => repo.is_template);

        return templateRepos;
    }

    @Get('/{courseId}/repos')
    async getRepos(@Path() courseId: number) {
        const { data: course } = await supabase.from('classes').select('*').eq('id', courseId).single();
        if (!course) {
            throw new Error('Course not found');
        }
        try {        
            return await GitHubController.getInstance().getRepos(course);
        } catch (error) {
            if('status' in (error as any) && (error as any).status === 404) {
                throw new NotFoundError(`Repository not found in ${course.name}`);
            }
            throw error;
        }
    }
    @Get('/{courseId}/repos/{orgName}/{repoName}/files')
    async listFilesInRepo(@Path() courseId: number, @Path() orgName: string, @Path() repoName: string) {
        // Validate that the repo belongs to the course
        // TODO support different orgs for different courses
        if(orgName !== 'autograder-dev' && orgName !== 'pawtograder') {
            throw new UserVisibleError(`Repository not found in ${orgName}`);
        }
        try {
            return await GitHubController.getInstance().listFilesInRepo(orgName + '/' + repoName);
        } catch (error) {
            if('status' in (error as any) && (error as any).status === 404) {
                throw new NotFoundError(`Repository ${orgName}/${repoName} not found`);
            }
            throw error;
        }
    }

    @Get('/{courseId}/repos/{orgName}/{repoName}/files/{path}')
    async getFileFromRepo(@Path() courseId: number, @Path() orgName: string, @Path() repoName: string, @Path() path: string) {
        // Validate that the repo belongs to the course
        // TODO support different orgs for different courses
        const org = 'autograder-dev';
        if(orgName !== org && orgName !== 'pawtograder') {
            throw new UserVisibleError(`Repository not found in ${org}`);
        }
        try {
            return await GitHubController.getInstance().getFileFromRepo(orgName + '/' + repoName, path);
        } catch (error) {
            if('status' in (error as any) && (error as any).status === 404) {
                throw new NotFoundError(`File ${path} not found in ${orgName}/${repoName}`);
            }
            throw error;
        }
    }

    @Post('/{courseId}/autograder/{assignmentId}/{studentId}')
    async testSolutionWorkflow(@Path() courseId: number, @Path() assignmentId: number, @Path() studentId: string) {
        throw new Error('Not implemented');
    }
}