// GET  /api/crm/canned-responses — list templates for the Composer
//                                   picker. Ordered by display_order.
// POST /api/crm/canned-responses — create a template. JSON for
//                                   text-only; multipart/form-data
//                                   when an image is attached.
//
// Auth: dual-mode bearer via src/lib/crmAuth (admin-only — every
// CRM caller is an admin under Phase 0).
//
// POST request shapes:
//   JSON  { label, body_text?, image_path?, display_order? }
//   FORM  label, body_text?, display_order?, image (File)
//
// When an image File is uploaded, server uploads to the
// canned-response-images bucket at {responseId}/{sanitizedFilename}
// and persists the storage path. We pre-allocate the row id so the
// storage key is deterministic before the INSERT lands.
//
// Returns the inserted row (image_path included; signed URL minted
// separately by /[id]/signed-url).

import { randomUUID } from "node:crypto";
import { authenticateCrm } from "@/lib/crmAuth";
import {
  CANNED_RESPONSE_BUCKET,
  uploadCannedResponseImage,
} from "@/lib/crmCannedResponses";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_LABEL_LEN = 120;
const MAX_BODY_LEN = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

type CannedResponseRow = {
  id: string;
  label: string;
  body_text: string | null;
  image_path: string | null;
  display_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const res = await supabase
    .from("crm_canned_responses")
    .select(
      "id, label, body_text, image_path, display_order, created_by, created_at, updated_at",
    )
    .order("display_order", { ascending: true })
    .order("label", { ascending: true });
  if (res.error) {
    console.error("[crm:canned-responses.list] db error", res.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  return Response.json({ responses: res.data ?? [] }, { status: 200 });
}

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;

  const id = randomUUID();
  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

  let label: string;
  let bodyText: string | null;
  let displayOrder: number;
  let imagePath: string | null = null;

  if (isMultipart) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Invalid multipart body" }, { status: 400 });
    }
    label = stringField(form.get("label"));
    bodyText = nullableStringField(form.get("body_text"));
    displayOrder = numberField(form.get("display_order"));
    const file = form.get("image");
    if (file && file instanceof File && file.size > 0) {
      const validation = validateImage(file);
      if (validation.error) {
        return Response.json({ error: validation.error }, { status: 400 });
      }
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        imagePath = await uploadCannedResponseImage({
          responseId: id,
          buffer,
          mimeType: file.type,
          filename: file.name,
        });
      } catch (err) {
        console.error("[crm:canned-responses.create] upload failed", err);
        return Response.json(
          { error: "Image upload failed" },
          { status: 500 },
        );
      }
    }
  } else {
    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Body must be JSON" }, { status: 400 });
    }
    label = stringField(payload.label);
    bodyText = nullableStringField(payload.body_text);
    displayOrder = numberField(payload.display_order);
    // JSON path accepts a pre-uploaded image_path (rare — admin
    // tool path uses multipart). Allow it for completeness.
    if (typeof payload.image_path === "string" && payload.image_path.trim()) {
      imagePath = payload.image_path.trim();
    }
  }

  const validation = validateRow({ label, bodyText, imagePath });
  if (validation.error) {
    if (imagePath) {
      // Roll back the storage upload so we don't leak orphans.
      await rollbackUpload(supabase, imagePath);
    }
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const ins = await supabase
    .from("crm_canned_responses")
    .insert({
      id,
      label,
      body_text: bodyText,
      image_path: imagePath,
      display_order: displayOrder,
      created_by: appUserId,
    })
    .select(
      "id, label, body_text, image_path, display_order, created_by, created_at, updated_at",
    )
    .single();
  if (ins.error || !ins.data) {
    if (imagePath) await rollbackUpload(supabase, imagePath);
    console.error("[crm:canned-responses.create] insert failed", ins.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  return Response.json({ response: ins.data as CannedResponseRow }, { status: 200 });
}

function stringField(v: FormDataEntryValue | unknown): string {
  if (typeof v === "string") return v.trim();
  return "";
}
function nullableStringField(v: FormDataEntryValue | unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}
function numberField(v: FormDataEntryValue | unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

function validateImage(file: File): { error?: string } {
  if (!ALLOWED_MIMES.has(file.type.toLowerCase())) {
    return { error: `Unsupported image type ${file.type}` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { error: "Image exceeds 5 MB limit" };
  }
  return {};
}

function validateRow(args: {
  label: string;
  bodyText: string | null;
  imagePath: string | null;
}): { error?: string } {
  if (!args.label) return { error: "label required" };
  if (args.label.length > MAX_LABEL_LEN) {
    return { error: `label exceeds ${MAX_LABEL_LEN} chars` };
  }
  if (args.bodyText && args.bodyText.length > MAX_BODY_LEN) {
    return { error: `body_text exceeds ${MAX_BODY_LEN} chars` };
  }
  if (!args.bodyText && !args.imagePath) {
    return { error: "Either body_text or an image is required" };
  }
  return {};
}

async function rollbackUpload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  imagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(CANNED_RESPONSE_BUCKET).remove([imagePath]);
  } catch (err) {
    console.error("[crm:canned-responses.create] rollback failed", err);
  }
}
