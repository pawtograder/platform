import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

// Deno types are provided by edge-runtime.d.ts import above
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
};

export type SurveyTemplateRequest = {
  operation: "POST" | "GET" | "UPDATE" | "DELETE";
  title?: string;
  template?: Json;
  class_id?: number;
  template_id?: string;
  scope?: "global" | "course";
  description?: string;
};

export type SurveyTemplateResponse = {
  success: boolean;
  template_id?: string;
  templates?: Json[];
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<SurveyTemplateResponse> {
  const requestBody = (await req.json()) as SurveyTemplateRequest;
  const { operation, title, template, class_id, template_id, scope: templateScope, description } = requestBody;

  scope?.setTag("function", "survey-save-as-template");
  scope?.setTag("operation", operation);
  if (title) scope?.setTag("title", title);
  if (class_id) scope?.setTag("class_id", class_id.toString());
  if (template_id) scope?.setTag("template_id", template_id);

  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  // Get current user ID
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error("Unauthorized");
  }

  const createTemplate = async () => {
    if (!title || !template || !class_id) {
        throw new Error("Missing required fields: title, template, class_id");
    }

    const { data: savedTemplate, error: templateError } = await supabase
      .from("survey_templates")
      .insert({
        title,
        template,
        class_id,
        scope: templateScope || "course",
        description: description || "",
        created_by: user.id
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
    const { data: templates, error: templatesError } = await supabase
      .from("survey_templates")
      .select("*")
      .order("created_at", { ascending: false });

    if (templatesError) {
      throw new Error(`Failed to get templates: ${templatesError.message}`);
    }
    
    return {
        success: true,
        templates: templates
    };
  };

  const updateTemplate = async () => {
    if (!template_id) {
        throw new Error("Missing template_id");
    }
    
    const updates: any = {};
    if (title) updates.title = title;
    if (template) updates.template = template;
    if (templateScope) updates.scope = templateScope;
    if (description) updates.description = description;

    const { error } = await supabase
        .from("survey_templates")
        .update(updates)
        .eq("id", template_id);

    if (error) {
        throw new Error(`Failed to update template: ${error.message}`);
    }

    return { success: true, template_id };
  };

  const deleteTemplate = async () => {
    if (!template_id) {
        throw new Error("Missing template_id");
    }

    const { error } = await supabase
        .from("survey_templates")
        .delete()
        .eq("id", template_id);

    if (error) {
        throw new Error(`Failed to delete template: ${error.message}`);
    }

    return { success: true };
  };

  switch (operation) {
    case "POST":
      return await createTemplate();
    case "GET":
      return await getTemplates();
    case "UPDATE":
      return await updateTemplate();
    case "DELETE":
      return await deleteTemplate();
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
