import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { Path, Post, Route, Security } from "tsoa";
import GitHubController from "../GitHubController.js";
import { Database } from "../SupabaseTypes.js";
import { CanvasController } from "./CanvasController.js";
import { CourseAdminController } from "./InstructorController.js";

export interface JWTUserRoles {
    class_id: number | null;
    role: string;
}

dotenv.config();

@Route('/api/admin')
@Security('supabase', ['admin'])
export class AdminServiceController {
    @Post('/course/{courseId}')
    async createCourseForCanvasCourse(@Path() courseId: number) {
        // Get the course from canvas
        const course = await this.canvasController.getCanvasCourse(courseId);
        // Create the class in Supabase
        const newClass = (await this.supabase.from('classes').insert({
            name: course.name,
            canvas_id: course.id,
            semester: 20241,
            time_zone: course.time_zone
        }).select()).data!.pop();
        const { id, canvas_id } = newClass!;
        if (!id || !canvas_id) {
            throw new Error('Failed to create class');
        }
        await new CourseAdminController().syncEnrollments(id);
    }

    async getTemplateRepos(courseId: number) {
        // Get course from supabase
        const { data: course } = await this.supabase.from('classes').select('*').eq('id', courseId).single();
        if (!course) {
            throw new Error('Course not found');
        }

        // Fetch repos from GitHub
        const repos = await this.gitHubController.getRepos(course);
        // const templateRepos = await this.supabase.from('template_repos').select('*').eq('class_id', courseId);
        return repos;
    }

    private gitHubController: GitHubController;
    private canvasController: CanvasController;
    private supabase: SupabaseClient<Database>
    public constructor() {
        this.gitHubController = GitHubController.getInstance();
        this.canvasController = new CanvasController();
        this.supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    }
}