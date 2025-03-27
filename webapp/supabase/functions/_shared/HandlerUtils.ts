const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
};

export async function wrapRequestHandler(
    req: Request,
    handler: (req: Request) => Promise<any>,
) {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    try {
        const data = await handler(req);
        return new Response(JSON.stringify(data), { status: 200 });
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
        return new Response(
            JSON.stringify(
                {
                    message: "Internal Server Error",
                    details: "An unknown error occurred",
                },
            ),
            { status: 500, headers: { "Content-Type": "application/json" } },
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
