"use server";

import { encodedRedirect } from "@/utils/utils";
import { createClient } from "@/utils/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const signInAction = async () => {
  const supabase = await createClient();

  const redirectTo = `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/auth/callback`
  console.log("Redirecting to")
  console.log(redirectTo)
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'email',
      redirectTo
    },
  })

  if (error) {
    return encodedRedirect("error", "/sign-in", error.message);
  }
  if (data.url) {
    console.log(`Redirecting to ${data.url}`);
    return redirect(data.url);
  }

  return redirect("/course");
};

export const signOutAction = async () => {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return redirect("/sign-in");
};

export const linkGitHubAction = async () => {
  const supabase = await createClient();
  //Make sure there is a session
  const session = await supabase.auth.getSession();
  if (!session) {
    return redirect("/sign-in");
  }
  console.log("Linking GitHub");
  console.log(session)
  const { data, error } = await supabase.auth.linkIdentity({
    provider: "github",
  });
  console.log(data);
  console.log(error);
  if (data.url)
    return redirect(data.url);
}