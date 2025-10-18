import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
export const updateSession = async (request: NextRequest) => {
  try {
    // Create a new Headers object to inject validated user ID
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("X-User-ID");

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
            // Reflect updated cookies in forwarded request headers
            const cookieHeader = request.cookies
              .getAll()
              .map(({ name, value }) => `${name}=${value}`)
              .join("; ");
            if (cookieHeader) requestHeaders.set("cookie", cookieHeader);
            response = NextResponse.next({
              request: {
                headers: requestHeaders
              }
            });

            // Set new cookies
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          }
        }
      }
    );

    const claims = await supabase.auth.getClaims();
    if (claims && claims.data && claims.data.claims) {
      // Inject the validated user ID into request headers for downstream handlers
      requestHeaders.set("X-User-ID", claims.data.claims.sub);
      const prevCookies = response.cookies.getAll();
      // Recreate response with updated request headers
      response = NextResponse.next({
        request: {
          headers: requestHeaders
        }
      });
      // restore previous cookies
      prevCookies.forEach((cookie) => response.cookies.set(cookie.name, cookie.value));
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
        const redirect = NextResponse.redirect(signInUrl);
        // propagate cookies set earlier in this middleware
        for (const { name, value } of response.cookies.getAll()) {
          redirect.cookies.set(name, value);
        }
        return redirect;
      }
    }

    if (request.nextUrl.pathname === "/" && !claims?.data?.claims?.sub) {
      const redirect = NextResponse.redirect(new URL("/course", request.url));
      for (const { name, value } of response.cookies.getAll()) {
        redirect.cookies.set(name, value);
      }
      return redirect;
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
