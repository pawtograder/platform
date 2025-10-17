import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
export const updateSession = async (request: NextRequest) => {
  try {
    // Create a new Headers object to inject validated user ID
    const requestHeaders = new Headers(request.headers);

    let response = NextResponse.next({
      request: {
        headers: requestHeaders
      }
    });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            response = NextResponse.next({
              request: {
                headers: requestHeaders
              }
            });
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          }
        }
      }
    );

    const claims = await supabase.auth.getClaims();
    if (claims && claims.data && claims.data.claims) {
      // Inject the validated user ID into request headers for downstream handlers
      requestHeaders.set("X-User-ID", claims.data.claims.sub);
      // Recreate response with updated request headers
      response = NextResponse.next({
        request: {
          headers: requestHeaders
        }
      });
      Sentry.setUser({
        id: claims.data.claims.sub,
        email: claims.data.claims.email
      });
    } else {
      Sentry.setUser(null);
    }

    // protected routes
    if (request.nextUrl.pathname.startsWith("/course")) {
      if (!claims || claims.error || !claims.data || !claims.data.claims) {
        const signInUrl = new URL("/sign-in", request.url);
        const originalPathWithSearch = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        signInUrl.searchParams.set("redirect", originalPathWithSearch);
        return NextResponse.redirect(signInUrl);
      }
    }

    if (request.nextUrl.pathname === "/" && !claims.error && !!claims.data?.claims) {
      return NextResponse.redirect(new URL("/course", request.url));
    }

    return response;
  } catch {
    // If you are here, a Supabase client could not be created!
    // This is likely because you have not set up environment variables.
    // Check out http://localhost:3000 for Next Steps.
    return NextResponse.next({
      request: {
        headers: request.headers
      }
    });
  }
};
