// PATCH  /api/crm/canned-responses/[id] — update a template.
//                                          Same body shapes as POST
//                                          /api/crm/canned-responses
//                                          (JSON for text-only, multipart
//                                          to upload/replace an image).
// DELETE /api/crm/canned-responses/[id] — hard delete row + storage
//                                          object.
//
// Auth: dual-mode bearer via src/lib/crmAuth (admin-only).
//
// PATCH semantics:
//   - Provided fields are updated. Unprovided fields are left as-is.
//   - On a multipart request with a new image, the old image_path is
//     deleted from storage before the new one is uploaded.
//   - Sending image_path = "" (or null) on the JSON path clears the
//     image and deletes the storage object.

import { authenticateCrm } from "@/lib/crmAuth";
import {
  deleteCannedResponseImage,
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

type RouteCtx = { params: Promise<{ id: string }> };

type ExistingRow = {
  id: string;
  label: string;
  body_text: string | null;
  image_path: string | null;
  display_order: number;
};

type UpdatePatch = {
  label?: string;
  body_text?: string | null;
  display_order?: number;
  image_path?: string | null;
};

export async function PATCH(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const existing = await supabase
    .from("crm_canned_responses")
    .select("id, label, body_text, image_path, display_order")
    .eq("id", id)
    .maybeSingle();
  if (existing.error) {
    console.error("[crm:canned-responses.update] lookup failed", existing.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!existing.data) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const row = existing.data as ExistingRow;

  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

  const patch: UpdatePatch = {};
  let newImagePath: string | null | undefined = undefined; // undefined = unchanged
  let oldImagePathToDelete: string | null = null;

  if (isMultipart) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Invalid multipart body" }, { status: 400 });
    }
    const label = form.get("label");
    if (typeof label === "string") patch.label = label.trim();
    const bodyText = form.get("body_text");
    if (typeof bodyText === "string") {
      const t = bodyText.trim();
      patch.body_text = t.length === 0 ? null : t;
    }
    const order = form.get("display_order");
    if (typeof order === "string") {
      const n = Number(order);
      if (Number.isFinite(n)) patch.display_order = Math.trunc(n);
    }
    const file = form.get("image");
    if (file && file instanceof File && file.size > 0) {
      const v = validateImage(file);
      if (v.error) return Response.json({ error: v.error }, { status: 400 });
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        newImagePath = await uploadCannedResponseImage({
          responseId: id,
          buffer,
          mimeType: file.type,
          filename: file.name,
        });
        // If the new path differs from the old, schedule the old
        // for deletion after the DB update lands.
        if (row.image_path && row.image_path !== newImagePath) {
          oldImagePathToDelete = row.image_path;
        }
      } catch (err) {
        console.error("[crm:canned-responses.update] upload failed", err);
        return Response.json(
          { error: "Image upload failed" },
          { status: 500 },
        );
      }
    }
    // Multipart path also accepts "clear_image=true" to drop the
    // existing image without uploading a new one.
    if (form.get("clear_image") === "true" && row.image_path) {
      newImagePath = null;
      oldImagePathToDelete = row.image_path;
    }
  } else {
    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Body must be JSON" }, { status: 400 });
    }
    if (typeof payload.label === "string") patch.label = payload.label.trim();
    if (payload.body_text === null) patch.body_text = null;
    else if (typeof payload.body_text === "string") {
      const t = payload.body_text.trim();
      patch.body_text = t.length === 0 ? null : t;
    }
    if (
      typeof payload.display_order === "number" &&
      Number.isFinite(payload.display_order)
    ) {
      patch.display_order = Math.trunc(payload.display_order);
    } else if (typeof payload.display_order === "string") {
      const n = Number(payload.display_order);
      if (Number.isFinite(n)) patch.display_order = Math.trunc(n);
    }
    if (payload.image_path === null || payload.image_path === "") {
      if (row.image_path) {
        newImagePath = null;
        oldImagePathToDelete = row.image_path;
      }
    }
  }

  if (newImagePath !== undefined) {
    patch.image_path = newImagePath;
  }

  // Validate final shape: label can't be cleared, content-present
  // CHECK constraint mirrored in JS so we 400 cleanly rather than
  // letting Postgres return its lower-level message.
  const finalLabel = patch.label ?? row.label;
  const finalBody = patch.body_text !== undefined ? patch.body_text : row.body_text;
  const finalImage = patch.image_path !== undefined ? patch.image_path : row.image_path;
  if (!finalLabel) {
    return Response.json({ error: "label required" }, { status: 400 });
  }
  if (finalLabel.length > MAX_LABEL_LEN) {
    return Response.json(
      { error: `label exceeds ${MAX_LABEL_LEN} chars` },
      { status: 400 },
    );
  }
  if (finalBody && finalBody.length > MAX_BODY_LEN) {
    return Response.json(
      { error: `body_text exceeds ${MAX_BODY_LEN} chars` },
      { status: 400 },
    );
  }
  if (!finalBody && !finalImage) {
    return Response.json(
      { error: "Either body_text or an image is required" },
      { status: 400 },
    );
  }

  if (Object.keys(patch).length === 0) {
    // No-op — return the existing row.
    return Response.json({ response: row }, { status: 200 });
  }

  const upd = await supabase
    .from("crm_canned_responses")
    .update(patch)
    .eq("id", id)
    .select(
      "id, label, body_text, image_path, display_order, created_by, created_at, updated_at",
    )
    .single();
  if (upd.error || !upd.data) {
    console.error("[crm:canned-responses.update] db error", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  if (oldImagePathToDelete) {
    await deleteCannedResponseImage(oldImagePathToDelete);
  }

  return Response.json({ response: upd.data }, { status: 200 });
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { id } = await ctx.params;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  // Read image_path first so we can clean storage after the row delete
  // succeeds.
  const lookup = await supabase
    .from("crm_canned_responses")
    .select("image_path")
    .eq("id", id)
    .maybeSingle();
  if (lookup.error) {
    console.error("[crm:canned-responses.delete] lookup failed", lookup.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const imagePath = (lookup.data?.image_path as string | null) ?? null;

  const del = await supabase
    .from("crm_canned_responses")
    .delete()
    .eq("id", id);
  if (del.error) {
    console.error("[crm:canned-responses.delete] delete failed", del.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  if (imagePath) {
    await deleteCannedResponseImage(imagePath);
  }
  return Response.json({ ok: true }, { status: 200 });
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
