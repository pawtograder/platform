import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

export type Request = {
  operation: "POST" | "GET" | "UPDATE" | "DELETE";
  title: string;
  template: Json;
  class_section_id?: number;
  class_id?: number;
  template_id?: string;
};

export type Response = {
  success: boolean;
  template_id?: string;
  template?: Json[];
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<Response> {
  const { title, template } = (await req.json()) as Request;

  scope?.setTag("function", "survey-save-as-template");
  scope?.setTag("title", title);
  scope?.setTag("template", JSON.stringify(template));
  scope?.setTag("class_section_id", class_section_id?.toString() || "");
  scope?.setTag("class_id", class_id?.toString() || "");

  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  switch (operation) {
    case "POST":
      return await createTemplate();
    case "GET":
      return await getTemplates();
    case "UPDATE":
      return await updateTemplate();
    case "DELETE":
      return await deleteTemplate();
  }

  const createTemplate = async () => {
    const { data: savedTemplate, error: templateError } = await supabase
      .from("survey_templates")
      .insert({
        title,
        template
      })
      .select("id")
      .single();

    if (templateError) {
      throw new Error(`Failed to create template: ${templateError.message}`);
    }

    return {
      success: true,
      template_id: savedTemplate.id
    };
  };

  const getTemplates = async () => {
    const { data: templates, error: templatesError } = await supabase.from("survey_templates").select("*");

    if (templatesError) {
      throw new Error(`Failed to get templates: ${templatesError.message}`);
    }
  };
  //TODO:  Implement update and delete templates
  const updateTemplate = async () => {};
  const deleteTemplate = async () => {};
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
