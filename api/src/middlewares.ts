import { createClient } from "@supabase/supabase-js";
import { NextFunction, Request, Response } from "express";
import { Database } from "./SupabaseTypes.js";
import { jwtDecode } from "jwt-decode";
import { JWTUserRoles } from "./api/AdminServiceController.js";

const supabase = createClient<Database>(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
export async function requiresCourseInstructorOrGrader(request: Request, response: Response, next: NextFunction) {
    const { headers } = request;
    console.log("requiresCourseInstructorOrGrader")
    console.log(headers)
    // Get the user object
    const token = (headers as any)['authorization'];
    if (!token) {
        return response.status(401).send('Unauthorized');
    }
    // Fetch from supabase
    const { data: user, error } = await supabase.auth.getUser(token);
    if (!user || !user.user) {
        return response.status(401).send('Unauthorized');
    }
    // Check user permissions from supabase
    const { user_roles } = jwtDecode(token) as { user_roles: JWTUserRoles[] };
    const course_id = parseInt(request.params.course_id);
    if (!user_roles.find(role => role.class_id === course_id && (role.role === 'instructor' || role.role === 'grader'))) {
        return response.status(403).send('Forbidden');
    }
    return next();
}
export async function requiresAdmin(request: Request, response: Response, next: NextFunction) {
    const { headers } = request;
    // Get the user object
    const token = (headers as any)['authorization'];
    if (!token) {
        return response.status(401).send('Unauthorized');
    }
    // Fetch from supabase
    const { data: user, error } = await supabase.auth.getUser(token);
    if (!user || !user.user) {
        return response.status(401).send('Unauthorized');
    }
    // Check user permissions from supabase
    const { user_roles } = jwtDecode(token) as { user_roles: JWTUserRoles[] };
    if (!user_roles.find(role => role.role === 'admin')) {
        return response.status(403).send('Forbidden');
    }
    return next();
} 