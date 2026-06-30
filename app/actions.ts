"use server";

import { createClient } from "@/utils/supabase/server";
import { encodedRedirect } from "@/utils/utils";
import { redirect } from "next/navigation";
import { env } from "process";
import { isSignupsEnabled } from "@/lib/features";
import { getBranding } from "@/lib/branding";

export const confirmEmailAction = async (formData: FormData) => {
  const token_hash = formData.get("token_hash");
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: token_hash as string,
    type: "email"
  });
  if (error) {
    return encodedRedirect("error", "/auth/confirm", error.message);
  }
  return redirect("/course");
};
export const acceptInvitationAction = async (formData: FormData) => {
  const password = formData.get("password");
  const token_hash = formData.get("token_hash");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: token_hash as string,
    type: "invite"
  });
  if (error) {
    return encodedRedirect("error", "/auth/accept-invitation", error.message);
  }
  if (data.user) {
    const { error: userError } = await supabase.auth.updateUser({
      password: password as string
    });
    if (userError) {
      return encodedRedirect("error", "/auth/accept-invitation", userError.message);
    }
    return encodedRedirect("success", "/course", "Password set successfully");
  }
};

export const setNewPasswordAction = async (formData: FormData) => {
  const token_hash = formData.get("token_hash");
  const supabase = await createClient();
  //Only try to login if the user is not already logged in, to allow multiple efforts to get the password to meet the requirements
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: token_hash as string,
      type: "email"
    });
    if (error) {
      return encodedRedirect("error", "/auth/reset-password", error.message);
    }
  }
  const password = formData.get("password");
  const { data: updateData, error: updateError } = await supabase.auth.updateUser({ password: password as string });
  if (updateError) {
    return encodedRedirect("error", "/auth/reset-password", updateError.message);
  }
  if (updateData.user) {
    return encodedRedirect("success", "/course", "Password reset successfully");
  }
};

export const signInWithMagicLinkAction = async (formData: FormData) => {
  const token_hash = formData.get("token_hash");
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({
    token_hash: token_hash as string,
    type: "magiclink"
  });
  if (error) {
    return encodedRedirect("error", "/auth/magic-link", error.message);
  }
  return redirect("/course");
};

export const signInOrSignUpWithEmailAction = async (data: FormData) => {
  const action = data.get("action");
  const email = data.get("email");
  const password = data.get("password");
  const redirectParam = data.get("redirect") as string | null;
  const redirectPath = redirectParam && redirectParam.startsWith("/") ? redirectParam : undefined;
  if (action === "signin") {
    return signInWithEmailAction(email as string, password as string, redirectPath);
  } else if (action === "signup") {
    return signUpWithEmailAction(email as string, password as string);
  } else if (action === "reset-password") {
    return resetPasswordAction(email as string);
  }
};

export const resetPasswordAction = async (email: string) => {
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/reset-password`
  });
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message, { email });
  }
  return encodedRedirect("success", "/sign-in", "Password reset email sent", { email });
};
export const signInWithEmailAction = async (email: string, password: string, redirectPath?: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const params: Record<string, string> = { email };
    if (redirectPath) params.redirect = redirectPath;
    return encodedRedirect("error", "/sign-in", error.message, params);
  }
  if (data.user) {
    return redirect(redirectPath ?? "/course");
  }
};
export const signUpWithEmailAction = async (email: string, password: string) => {
  if (!isSignupsEnabled()) {
    return encodedRedirect("error", "/sign-in", "Signups are currently disabled");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/`
    }
  });
  if (error) {
    return encodedRedirect("error", "/sign-in", error.message);
  }
  if (!data.user?.confirmed_at) {
    return encodedRedirect(
      "success",
      "/sign-in",
      "Account created successfully, but must be confirmed. Please check your email for a confirmation link."
    );
  }
  if (data.user) {
    return redirect("/course");
  }
};
/**
 * Generic SSO sign-in. The sign-in page renders one button per configured
 * provider (web.branding.ssoProviders / BRAND_SSO_PROVIDERS) and submits the
 * provider's index. We re-read the branding config SERVER-SIDE and look the
 * entry up by index, so the provider id and OAuth scopes come from trusted
 * config rather than the (tamperable) client form.
 */
export const signInWithSSOAction = async (formData: FormData) => {
  const supabase = await createClient();

  const redirectParam = formData.get("redirect") as string | null;
  const nextPath = redirectParam && redirectParam.startsWith("/") ? redirectParam : "/";

  // Validate sso_index explicitly: Number(null/"") is 0, which would silently
  // select the first provider for a missing/blank field. Require a non-empty,
  // integer-only string.
  const rawIndex = formData.get("sso_index");
  const providers = getBranding().ssoProviders;
  const cfg = typeof rawIndex === "string" && /^\d+$/.test(rawIndex) ? providers[Number(rawIndex)] : undefined;
  if (!cfg) {
    return encodedRedirect("error", "/sign-in", "Unknown sign-in provider", { redirect: nextPath });
  }

  const redirectTo = `${env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL}/auth/callback?next=${encodeURIComponent(nextPath)}`;
  const { data: authData, error } = await supabase.auth.signInWithOAuth({
    provider: cfg.provider,
    options: { ...(cfg.scopes ? { scopes: cfg.scopes } : {}), redirectTo }
  });

  if (error) {
    return encodedRedirect("error", "/sign-in", error.message, { redirect: nextPath });
  }

  if (authData.url) {
    return redirect(authData.url);
  }

  return redirect(nextPath || "/course");
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
  const { data } = await supabase.auth.linkIdentity({ provider: "github" });
  if (data.url) return redirect(data.url);
};

export const linkDiscordAction = async () => {
  const supabase = await createClient();
  //Make sure there is a session
  const session = await supabase.auth.getSession();
  if (!session || !session.data.session?.user) {
    return redirect("/sign-in");
  }
  const { data } = await supabase.auth.linkIdentity({ provider: "discord" });
  if (data.url) return redirect(data.url);
};
