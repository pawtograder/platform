import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { assertUserIsInstructorOrGrader, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { getExamVisionProvider, type PageImage } from "../_shared/examVision.ts";

type ExtractTemplateRequest = { exam_id: number };

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { exam_id } = (await req.json()) as ExtractTemplateRequest;
  scope?.setTag("function", "exam-extract-template");
  scope?.setTag("exam_id", String(exam_id));

  const admin = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: exam, error } = await admin.from("exams").select("id, class_id").eq("id", exam_id).single();
  if (error || !exam) throw new Error(`Exam ${exam_id} not found`);

  // authorize the caller as staff for this class
  await assertUserIsInstructorOrGrader(exam.class_id, req.headers.get("Authorization")!);

  const { data: pages } = await admin
    .from("exam_template_pages")
    .select("page_number, image_path, width, height")
    .eq("exam_id", exam_id)
    .order("page_number", { ascending: true });

  const images: PageImage[] = [];
  for (const p of pages ?? []) {
    const { data, error: dlErr } = await admin.storage.from("exam-templates").download(p.image_path);
    if (dlErr || !data) continue;
    images.push({
      name: p.image_path,
      bytes: new Uint8Array(await data.arrayBuffer()),
      width: p.width ?? 0,
      height: p.height ?? 0
    });
  }

  const provider = getExamVisionProvider();
  return await provider.extractTemplate(images);
}

Deno.serve((req) => wrapRequestHandler(req, handleRequest));
