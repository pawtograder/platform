import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images - .svg, .png, .jpg, .jpeg, .gif, .webp
     * - /paws (PostHog)
     * - /tunnel (Sentry)
     * Feel free to modify this pattern to include more paths.
     */
    /*
     * Skip API routes: they use their own auth and do not need cookie refresh or X-User-ID.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)|paws|tunnel$).*)"
  ]
};
