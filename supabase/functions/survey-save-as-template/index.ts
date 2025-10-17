import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

export type SaveSurveyAsTemplateRequest = {
  title: string;
  template: Json;
};

export type SaveSurveyAsTemplateResponse = {
  success: boolean;
  template_id: string;
};

async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<SaveSurveyAsTemplateResponse> {
  const { title, template } = (await req.json()) as SaveSurveyAsTemplateRequest;

  scope?.setTag("function", "survey-save-as-template");
  scope?.setTag("title", title);
  scope?.setTag("template", JSON.stringify(template));
  
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! }
      }
    }
  );

  // Create the template
  const { data: savedTemplate, error: templateError } = await supabase
    .from("survey_templates")
    .insert({
      title,
      template,
    })
    .select("id")
    .single();

  if (templateError) {
    throw new Error(`Failed to create template: ${templateError.message}`);
  }

  return {
    success: true,
    template_id: savedTemplate.id,
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});

/*
How to use this function:

*/
