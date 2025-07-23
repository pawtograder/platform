import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const next = searchParams.get("next") ?? "/accept-invitation";
  if (token_hash) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: "email",
      options: { redirectTo: `${origin}${next}` }
    });
    if (error) {
      return NextResponse.redirect(`${origin}/auth/auth-code-error?error=${error.message}`);
    }
    return NextResponse.redirect(`${origin}${next}`);
  }
}
