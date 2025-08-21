import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wrapRequestHandler, UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// Microsoft Graph API types
interface AzureUserProfile {
  employeeId: string | null;
  mail: string;
  surname: string | null;
  givenName: string | null;
  department: string | null;
  userPrincipalName: string;
  jobTitle: string | null;
  accountEnabled: boolean;
}

interface FetchAzureProfileRequest {
  accessToken: string;
}

/**
 * Edge function that fetches user profile data from Microsoft Graph API
 * and updates the user's sis_user_id in the database.
 *
 * Called when a user logs in via Azure OAuth and doesn't have sis_user_id set.
 */
async function handleRequest(req: Request, scope: Sentry.Scope) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders
    });
  }

  scope?.setTag("function", "user-fetch-azure-profile");

  try {
    // Get the user's Supabase session
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Missing Authorization header");
    }

    const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } }
    });

    // Verify the user is authenticated
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser();
    if (authError || !user) {
      scope?.setContext("auth_error", { error: authError });
      throw new Error("Authentication failed");
    }

    scope?.setUser({ id: user.id, email: user.email });

    // Get the access token from request body
    const { accessToken } = (await req.json()) as FetchAzureProfileRequest;
    if (!accessToken) {
      throw new Error("Missing access token");
    }

    // Check if user already has sis_user_id set
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: existingUser, error: userFetchError } = await adminSupabase
      .from("users")
      .select("sis_user_id, email, name")
      .eq("user_id", user.id)
      .single();

    if (userFetchError) {
      scope?.setContext("user_fetch_error", { error: userFetchError });
      throw new Error("Failed to fetch user data");
    }

    if (existingUser?.sis_user_id) {
      scope?.addBreadcrumb({
        message: "User already has sis_user_id",
        category: "info",
        data: { sis_user_id: existingUser.sis_user_id }
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: "User already has SIS ID",
          sis_user_id: existingUser.sis_user_id
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Fetch user profile from Microsoft Graph API
    scope?.addBreadcrumb({
      message: "Fetching user profile from Microsoft Graph API",
      category: "api"
    });

    const graphResponse = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=employeeId,mail,surname,givenName,department,userPrincipalName,jobTitle,accountEnabled",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!graphResponse.ok) {
      const errorText = await graphResponse.text();
      scope?.setContext("graph_api_error", {
        status: graphResponse.status,
        statusText: graphResponse.statusText,
        error: errorText
      });
      throw new Error(`Microsoft Graph API error: ${graphResponse.status} - ${errorText}`);
    }

    const azureProfile: AzureUserProfile = await graphResponse.json();
    scope?.setContext("azure_profile", {
      employeeId: azureProfile.employeeId,
      mail: azureProfile.mail,
      userPrincipalName: azureProfile.userPrincipalName,
      accountEnabled: azureProfile.accountEnabled
    });

    // Validate that we got an employeeId
    if (!azureProfile.employeeId) {
      scope?.addBreadcrumb({
        message: "No employeeId found in Azure profile",
        category: "warning",
        data: azureProfile
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: "No employee ID found in Azure profile"
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Check if account is enabled
    if (!azureProfile.accountEnabled) {
      scope?.addBreadcrumb({
        message: "Azure account is disabled",
        category: "warning"
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: "Azure account is disabled"
        }),
        {
          status: 403,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Update user with sis_user_id
    const { error: updateError } = await adminSupabase
      .from("users")
      .update({
        sis_user_id: azureProfile.employeeId
      })
      .eq("user_id", user.id);

    if (updateError) {
      scope?.setContext("update_error", { error: updateError });
      throw new Error(`Failed to update user: ${updateError.message}`);
    }

    scope?.addBreadcrumb({
      message: "Successfully updated user with SIS ID",
      category: "success",
      data: { sis_user_id: azureProfile.employeeId }
    });

    // Return success response with profile data
    return new Response(
      JSON.stringify({
        success: true,
        message: "SIS ID updated successfully",
        sis_user_id: azureProfile.employeeId,
        profile: {
          employeeId: azureProfile.employeeId,
          mail: azureProfile.mail,
          givenName: azureProfile.givenName,
          surname: azureProfile.surname,
          department: azureProfile.department,
          jobTitle: azureProfile.jobTitle,
          userPrincipalName: azureProfile.userPrincipalName
        }
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Error in user-fetch-azure-profile:", error);
    scope?.captureException(error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );
  }
}

// Initialize Sentry
Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("ENVIRONMENT") || "development"
});

Deno.serve(async (req: Request) => {
  return await Sentry.withScope(async (scope) => {
    return await handleRequest(req, scope);
  });
});
