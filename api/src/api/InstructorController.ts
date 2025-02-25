import { createClient, User } from "@supabase/supabase-js";
import { sluggify } from "@theredhead/core-functions";
import { Get, Path, Post, Route, Security } from "tsoa";
import { CanvasController } from "./CanvasController.js";
import GitHubController from "../GitHubController.js";
import { Database } from "../SupabaseTypes.js";

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
            .select('*, classes(slug, user_roles(profiles(id, name,github_username, sortable_name)))') // , classes(canvas_id), user_roles(user_id)')
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
            userRole.profiles.github_username &&
            !existingRepos?.find(repo => repo.user_id === userRole.profiles.id));

        const createRepo = async (uid: string, name: string, github_username: string) => {
            const repoName = `${assignment.classes?.slug}-${assignment.slug}-${github_username}`;
            console.log(`Creating repo ${repoName} for ${name}`);
            await GitHubController.getInstance().createRepo('autograder-dev', repoName, assignment.template_repo, github_username);
            const {error} = await supabase.from('repositories').insert({
                user_id: uid,
                assignment_id: assignmentId,
                repository: 'autograder-dev/' + repoName,
            });
            if (error) {
                console.error(error);
            }
        }
        await Promise.all(reposToCreate.map(async (userRole) => createRepo(userRole.profiles.id, userRole.profiles.name!, userRole.profiles.github_username!)));


    }
    @Post('/{courseId}/enrollments')
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
            const addRole = (user: User) => supabase.from('user_roles').insert({
                role: dbRoleForCanvasRole(enrollment.role),
                class_id: courseId!,
                canvas_id: enrollment.id,
                user_id: user.id,
            });
            if (existingUser) {
                // Update the profile, creating it if it doesn't exist
                await supabase.from('profiles').upsert({
                    name: user.name,
                    sis_user_id: user.sis_user_id,
                    time_zone: user.time_zone,
                    sortable_name: user.sortable_name,
                    short_name: user.short_name,
                    avatar_url: user.avatar_url,
                    id: existingUser.id,
                });

                // Add the enrollment
                await addRole(existingUser);
            } else {
                // Create user
                const newUser = await supabase.auth.admin.createUser({
                    email: user.primary_email,
                });

                // Create profile
                await supabase.from('profiles').insert({
                    id: newUser.data.user!.id,
                    name: user.name,
                    sis_user_id: user.sis_user_id,
                    time_zone: user.time_zone,
                    sortable_name: user.sortable_name,
                    short_name: user.short_name,
                    avatar_url: user.avatar_url,
                });
                // Add the role
                await addRole(newUser.data.user!);
            }
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
        // const templateRepos = await this.supabase.from('template_repos').select('*').eq('class_id', courseId);
        return repos;

    }
}