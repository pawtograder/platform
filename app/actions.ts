"use server";

import { createClient } from "@/utils/supabase/server";
import { encodedRedirect } from "@/utils/utils";
import { redirect } from "next/navigation";

export const setNewPasswordAction = async (formData: FormData) => {
  const password = formData.get("password");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.updateUser({
    password: password as string,
  });
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message);
  }
  if(data.user) {
    return encodedRedirect("success", "/course", "Password reset successfully");
  }
}
export const signInOrSignUpWithEmailAction = async (data: FormData) => {
  const action = data.get("action");
  const email = data.get("email");
  const password = data.get("password");
  if (action === "signin") {
    return signInWithEmailAction(email as string, password as string);
  } else if (action === "signup") {
    return signUpWithEmailAction(email as string, password as string);
  } else if (action === "reset-password") {
    return resetPasswordAction(email as string);
  }
}
export const resetPasswordAction = async (email: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/reset-password`
  });
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message, { email });
  }
    return encodedRedirect("success", "/sign-in", "Password reset email sent", { email });
}
export const signInWithEmailAction = async (email: string, password: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message, { email });
  }
  if (data.user) {
    return redirect("/course");
  }
}
export const signUpWithEmailAction = async (email: string, password: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/`
    }
  })
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message);
  }
  if(!data.user?.confirmed_at) {
    return encodedRedirect("success", "/sign-in", "Account created successfully, but must be confirmed. Please check your email for a confirmation link.");
  }
  if (data.user) {
    return redirect("/course");
  }
}
export const signInWithMicrosoftAction = async () => {
  const supabase = await createClient();

  const redirectTo = `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/auth/callback`
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