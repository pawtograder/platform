import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { channelHostSuffix, currentChannel, hostForChannel, STABLE_CHANNEL } from "@/utils/channels";
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
        // Cross-subdomain session: when set (e.g. ".staging.pawtograder.net"),
        // scope the auth cookies to the parent domain so a session survives a
        // redirect between deployment-channel hosts (<channel>.<base>). Unset on
        // local/supabase.com/single-channel installs => host-only cookies, unchanged.
        ...(process.env.NEXT_PUBLIC_SESSION_COOKIE_DOMAIN
          ? { cookieOptions: { domain: process.env.NEXT_PUBLIC_SESSION_COOKIE_DOMAIN } }
          : {}),
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
        //Clear cookies
        response.cookies.delete("sb-access-token");
        response.cookies.delete("sb-refresh-token");
        const originalPathWithSearch = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        signInUrl.searchParams.set("redirect", originalPathWithSearch);
        return NextResponse.redirect(signInUrl);
      }
    }

    // A/B deployment channels: send each course to the host running its pinned
    // channel's build (classes.deployment_channel). Entirely gated on
    // NEXT_PUBLIC_CHANNEL_HOST_SUFFIX so deployments without channels (local,
    // supabase.com, single-channel staging/prod) do ZERO extra work — no DB
    // lookup. Only /course/<id> is course-scoped, so that's the only path where
    // a channel can be resolved.
    if (channelHostSuffix() && claims?.data?.claims) {
      const courseMatch = request.nextUrl.pathname.match(/^\/course\/(\d+)(?:\/|$)/);
      if (courseMatch) {
        const courseId = Number(courseMatch[1]);
        const { data: cls } = await supabase
          .from("classes")
          .select("deployment_channel")
          .eq("id", courseId)
          .maybeSingle();
        const courseChannel = cls?.deployment_channel || STABLE_CHANNEL;
        if (courseChannel !== currentChannel()) {
          const targetHost = hostForChannel(courseChannel);
          if (targetHost && targetHost !== request.nextUrl.host) {
            const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, `https://${targetHost}`);
            return NextResponse.redirect(target);
          }
        }
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
