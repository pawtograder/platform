import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
export const updateSession = async (request: NextRequest) => {
  // This `try/catch` block is only here for the interactive tutorial.
  // Feel free to remove once you have Supabase connected.
  try {
    // Create an unmodified response
    let response = NextResponse.next({
      request: {
        headers: request.headers
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
              request
            });
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          }
        }
      }
    );

    // This will refresh session if expired - required for Server Components
    // https://supabase.com/docs/guides/auth/server-side/nextjs
    /*
      We use the getSession API instead of getUser for performance:
      - getUser fetches from auth server
      - getSession fetches the JWT from the browser

      The JWT might have been revoked, so it is best for security to use getUser when
      relying upon the user object for security checks.

      However, we don't rely on the user object for security checks: we use Postgres RLS!
    */
    const session = await supabase.auth.getSession();
    if (session && session.data.session) {
      Sentry.setUser({
        id: session.data.session.user.id,
        email: session.data.session.user.email
      });
    } else {
      Sentry.setUser(null);
    }

    // protected routes
    if (request.nextUrl.pathname.startsWith("/course") && session.error) {
      const signInUrl = new URL("/sign-in", request.url);
      const originalPathWithSearch = `${request.nextUrl.pathname}${request.nextUrl.search}`;
      signInUrl.searchParams.set("redirect", originalPathWithSearch);
      return NextResponse.redirect(signInUrl);
    }
    // const urlError = request.nextUrl.searchParams.get("error");
    // if (urlError && request.nextUrl.pathname !== "/error" && request.nextUrl.pathname !== "/sign-in") {
    // return NextResponse.redirect(new URL(`/error?${request.nextUrl.searchParams.toString()}`, request.url));
    // }
    if (request.nextUrl.pathname === "/" && !session.error) {
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
