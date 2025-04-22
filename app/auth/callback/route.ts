import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  // The `/auth/callback` route is required for the server-side auth flow implemented
  // by the SSR package. It exchanges an auth code for the user's session.
  // https://supabase.com/docs/guides/auth/server-side/nextjs
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const next = searchParams.get('next') ?? '/'
  if (token_hash) {
    const supabase = await createClient();
    const { error, data } = await supabase.auth.verifyOtp({
      token_hash,
      type: "email",
      options: {
        redirectTo: `${origin}${next}`
      }
    })
    if (error) {
      return NextResponse.redirect(`${origin}/auth/auth-code-error?error=${error.message}`);
    }
    return NextResponse.redirect(`${origin}${next}`);
  }
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      const forwardedHost = request.headers.get('x-forwarded-host') // original origin before load balancer
      const isLocalEnv = process.env.NODE_ENV === 'development'
      if (isLocalEnv) {
        // we can be sure that there is no load balancer in between, so no need to watch for X-Forwarded-Host
        return NextResponse.redirect(`${origin}${next}`)
      } else if (forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${next}`)
      } else {
        return NextResponse.redirect(`${origin}${next}`)
      }
    }
  }
  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
