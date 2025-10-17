import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

async function getCachedJWKS() {
  const PROJECT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const jwks = await fetch(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`, {
    next: {
      tags: ["jwks"],
      revalidate: 60 * 60 // 1 hour
    }
  });
  if (!jwks.ok) {
    throw new Error("Failed to fetch JWKS");
  }
  const ret = await jwks.json();
  return ret;
}
export const updateSession = async (request: NextRequest) => {
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

  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession();
  if (sessionError) {
    console.error(sessionError);
    Sentry.captureException(sessionError);
  }
  if (sessionError || !session) {
    return NextResponse.next({
      request: {
        headers: requestHeaders
      }
    });
  }
  const jwks = await getCachedJWKS();
  const claims = await supabase.auth.getClaims(session.access_token, jwks);
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
};
