import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "./SupabaseTypes.d.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
};
export async function assertUserIsInstructor(
    courseId: number,
    authHeader: string,
) {
    const supabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
            global: {
                headers: { Authorization: authHeader },
            },
        },
    );
    const token = authHeader.replace("Bearer ", "");
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser(token);
    if (error) {
        console.error(error);
    }
    if (!user) {
        throw new SecurityError("User not found");
    }
    const { data: instructor } = await supabase.from("user_roles").select("*")
        .eq("user_id", user.id).eq("class_id", courseId).eq(
            "role",
            "instructor",
        ).single();
    if (!instructor) {
        throw new SecurityError("User is not an instructor for this course");
    }
    return supabase;
}
export async function assertUserIsInCourse(
    courseId: number,
    authHeader: string,
) {
    const supabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
            global: {
                headers: { Authorization: authHeader },
            },
        },
    );
    const token = authHeader.replace("Bearer ", "");
    const {
        data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) {
        throw new SecurityError("User not found");
    }
    const { data: instructor } = await supabase.from("user_roles").select("*")
        .eq("user_id", user.id).eq("class_id", courseId).single();
    if (!instructor) {
        throw new SecurityError("User is not an instructor for this course");
    }
    return supabase;
}

export async function wrapRequestHandler(
    req: Request,
    handler: (req: Request) => Promise<any>,
) {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    try {
        const data = await handler(req);
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: corsHeaders,
        });
    } catch (e) {
        console.error(e);
        if (e instanceof SecurityError) {
            return new Response(
                JSON.stringify(
                    {
                        message: "Security Error",
                        details: "This request has been reported to the staff",
                    },
                ),
                {
                    status: e.status,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
        if (e instanceof UserVisibleError) {
            return new Response(
                JSON.stringify(
                    {
                        message: "Internal Server Error",
                        details: e.details,
                    },
                ),
                {
                    status: e.status,
                    headers: { "Content-Type": "application/json" },
                },
            );
        }
        if (e instanceof NotFoundError) {
            return new Response(
                JSON.stringify(
                    {
                        message: "Not Found",
                        details: "The requested resource was not found",
                    },
                ),
                {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                    ...corsHeaders,
                },
            );
        }
        return new Response(
            JSON.stringify(
                {
                    message: "Internal Server Error",
                    details: "An unknown error occurred",
                },
            ),
            {
                status: 500,
                headers: { "Content-Type": "application/json" },
                ...corsHeaders,
            },
        );
    }
}
export class SecurityError extends Error {
    details: string;
    status: number = 401;
    constructor(details: string) {
        super("Security Error");
        this.details = details;
    }
}

export class UserVisibleError extends Error {
    details: string;
    status: number = 500;
    constructor(details: string) {
        super("Error");
        this.details = details;
    }
}
export class NotFoundError extends Error {
    details: string;
    status: number = 404;
    constructor(details: string) {
        super("Not Found");
        this.details = details;
    }
}
