import * as Sentry from "@sentry/nextjs";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import {
  channelHostSuffix,
  currentChannel,
  hostForChannel,
  sessionCookieOptions,
  STABLE_CHANNEL
} from "@/utils/channels";
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
        // Cross-subdomain session: scope the auth cookies to the parent zone so a
        // session survives a redirect between deployment-channel hosts. Derived
        // from the channel host suffix; a no-op on local/supabase.com/single-channel
        // installs (host-only cookies, unchanged). See utils/channels.ts.
        ...sessionCookieOptions(),
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
    // Only GET navigations are safe to bounce cross-host: a 307/308 redirect
    // replays method + body, so a Server Action POST would be re-issued to the
    // channel host where Next.js's same-origin Origin check rejects it (a failed
    // or duplicated mutation instead of a clean re-route). A page load that
    // lands on the wrong host is always a GET, so gating on GET loses nothing.
    if (channelHostSuffix() && claims?.data?.claims && request.method === "GET") {
      const courseMatch = request.nextUrl.pathname.match(/^\/course\/(\d+)(?:\/|$)/);
      if (courseMatch) {
        const courseId = Number(courseMatch[1]);
        const { data: cls, error: clsError } = await supabase
          .from("classes")
          .select("deployment_channel")
          .eq("id", courseId)
          .maybeSingle();
        // Fail CLOSED: on a transient read error (statement timeout, pool
        // exhaustion, RLS/role hiccup) we don't know the course's channel, so
        // stay on the current host rather than falling back to "stable" — that
        // fallback would bounce a canary user off the canary host mid-session
        // (and back once the DB recovers), a visible flap. Log it so the glitch
        // isn't silent.
        if (clsError) {
          Sentry.captureException(clsError, {
            tags: { feature: "deployment-channels" },
            extra: { courseId, currentChannel: currentChannel() }
          });
        } else {
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
