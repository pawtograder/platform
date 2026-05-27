import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";
import { buildCsp, cspHeaderName, generateNonce, isReportOnlyMode } from "@/utils/csp";

export async function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const reportOnly = isReportOnlyMode();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production", reportOnly });

  // Next.js auto-applies the nonce to its own inline scripts only if it finds
  // the CSP on the *request* headers (it greps `'nonce-…'` out of script-src).
  // Setting only the response header is not enough — Next never sees it.
  request.headers.set("x-nonce", nonce);
  request.headers.set("Content-Security-Policy", csp);

  const response = await updateSession(request);
  response.headers.set(cspHeaderName(), csp);
  // X-Frame-Options is the pre-CSP clickjacking control; modern browsers
  // prefer CSP `frame-ancestors` but honour XFO when frame-ancestors is
  // absent (which is the case under report-only mode, since the directive
  // is spec'd to be ignored there).
  response.headers.set("X-Frame-Options", "DENY");
  return response;
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
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)|paws|tunnel$).*)"
  ]
};
