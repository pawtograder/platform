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
    const { data: enrollment } = await supabase.from("user_roles").select("*")
        .eq("user_id", user.id).eq("class_id", courseId).eq(
            "role",
            "instructor",
        ).single();
    if (!enrollment) {
        throw new SecurityError("User is not an instructor for this course");
    }
    return { supabase, enrollment };;
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
    const { data: enrollment } = await supabase.from("user_roles").select("*")
        .eq("user_id", user.id).eq("class_id", courseId).single();
    if (!enrollment) {
        throw new SecurityError("User is not enrolled in this course");
    }
    return { supabase, enrollment };
}

export async function wrapRequestHandler(
    req: Request,
    handler: (req: Request) => Promise<any>,
) {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    try {
        let data = await handler(req);
        if (!data) {
            data = {};
        }
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: corsHeaders,
        });
    } catch (e) {
        console.error(e);
        const genericErrorHeaders = {
            "Content-Type": "application/json",
            ...corsHeaders,
        }
        if (e instanceof SecurityError) {
            return new Response(
                JSON.stringify(
                    {
                        error: {
                            recoverable: false,
                            message: "Security Error",
                            details: "This request has been reported to the staff",
                        }
                    },
                ),
                {
                    headers: genericErrorHeaders,
                },
            );
        }
        if (e instanceof UserVisibleError) {
            return new Response(
                JSON.stringify(
                    {
                        error: {
                            recoverable: false,
                            message: "Internal Server Error",
                            details: e.details,
                        },
                    },
                ),
                {
                    headers: genericErrorHeaders,
                },
            );
        }
        if (e instanceof NotFoundError) {
            return new Response(
                JSON.stringify(
                    {
                        error: {
                            recoverable: true,
                            message: "Not Found",
                            details: "The requested resource was not found",
                        }
                    },
                ),
                {
                    headers: genericErrorHeaders,
                },
            );
        }
        if (e instanceof IllegalArgumentError) {
            return new Response(
                JSON.stringify(
                    {
                        error: {
                            recoverable: true,
                            message: "Illegal Argument",
                            details: e.details,
                        }
                    },
                ),
                {
                    headers: genericErrorHeaders,
                },
            );
        }
        return new Response(
            JSON.stringify(
                {
                    error: {
                        recoverable: false,
                        message: "Internal Server Error",
                        details: "An unknown error occurred",
                    },
                },
            ),
            {
                headers: genericErrorHeaders,
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

export class IllegalArgumentError extends Error {
    details: string;
    status: number = 400;
    constructor(details: string) {
        super("Illegal Argument");
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
