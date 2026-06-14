import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { decodeJwtPayloadUnsafe, isJwtExpired, middlewareNeedsSupabaseGetSession } from "./jwtPayload";
import { readAccessTokenFromSupabaseCookies, supabaseAuthCookieStorageKeyFromUrl } from "./middlewareSession";

export const updateSession = async (request: NextRequest) => {
  try {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("X-User-ID");

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const storageKey = supabaseAuthCookieStorageKeyFromUrl(supabaseUrl);

    let accessToken = readAccessTokenFromSupabaseCookies(request, storageKey);
    let payload = accessToken ? decodeJwtPayloadUnsafe(accessToken) : null;

    type CookieSet = { name: string; value: string; options?: Record<string, unknown> };
    const refreshedCookies: CookieSet[] = [];

    if (middlewareNeedsSupabaseGetSession(accessToken, payload)) {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            refreshedCookies.length = 0;
            cookiesToSet.forEach(({ name, value, options }) =>
              refreshedCookies.push({ name, value, options: options as Record<string, unknown> | undefined })
            );
          }
        }
      });

      const { data, error } = await supabase.auth.getSession();
      if (!error && data.session) {
        accessToken = data.session.access_token;
        payload = decodeJwtPayloadUnsafe(accessToken);
      }
    }

    const authed = !!(payload?.sub && !isJwtExpired(payload));

    if (authed && payload?.sub) {
      requestHeaders.set("X-User-ID", payload.sub);
      Sentry.setUser({
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined
      });
    } else {
      Sentry.setUser(null);
    }

    let response = NextResponse.next({
      request: {
        headers: requestHeaders
      }
    });

    for (const c of refreshedCookies) {
      response.cookies.set(c.name, c.value, c.options as Parameters<typeof response.cookies.set>[2]);
    }

    if (request.nextUrl.pathname.startsWith("/course")) {
      if (!authed) {
        const signInUrl = new URL("/sign-in", request.url);
        response.cookies.delete("sb-access-token");
        response.cookies.delete("sb-refresh-token");
        const originalPathWithSearch = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        signInUrl.searchParams.set("redirect", originalPathWithSearch);
        return NextResponse.redirect(signInUrl);
      }
    }

    if (request.nextUrl.pathname === "/" && authed) {
      const redirectRes = NextResponse.redirect(new URL("/course", request.url));
      for (const c of refreshedCookies) {
        redirectRes.cookies.set(c.name, c.value, c.options as Parameters<typeof redirectRes.cookies.set>[2]);
      }
      return redirectRes;
    }

    return response;
  } catch {
    return NextResponse.next({
      request: {
        headers: request.headers
      }
    });
  }
};
