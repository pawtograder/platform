import { createClient } from "@supabase/supabase-js";
import * as express from "express";
import { Database } from "../SupabaseTypes.js";
import { jwtDecode } from "jwt-decode";
import { JWTUserRoles } from "./AdminServiceController.js";

const supabase = createClient<Database>(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
export async function expressAuthentication(
    request: express.Request,
    securityName: string,
    scopes?: string[]
): Promise<any> {
    if (securityName === 'supabase') {
        const { headers } = request;
        // Get the user object
        const token = (headers as any).authorization;
        if (!token) {
            throw new Error('Unauthorized');
        }
        // Fetch from supabase
        const { data: user, error } = await supabase.auth.getUser(token);
        if (!user || !user.user) {
            throw new Error('Unauthorized');
        }
        const { user_roles } = jwtDecode(token) as { user_roles: JWTUserRoles[] };
        if (scopes?.includes('admin')) {
            // Check user permissions from supabase
            if (!user_roles.find(role => role.role === 'admin')) {
                throw new Error('Forbidden');
            }
        } else if (scopes?.includes('instructor')) {
            const course_id = parseInt(request.params.courseId);
            if (!course_id){
                throw new Error('Course ID not found on request');
            }
            if (!user_roles.find(
                role =>
                    role.role === 'admin' ||
                    (role.class_id === course_id && (role.role === 'instructor' || role.role === 'grader')))) {
                throw new Error('Forbidden');
            }
        }

    }

}