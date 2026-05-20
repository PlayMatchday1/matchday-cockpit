// Client-side image compression for outbound media (Composer) and
// curated assets (admin canned-responses). Resizes images to a
// 1920px longest-edge JPEG and steps the JPEG quality down (0.85
// → 0.4) until the result fits the byte cap. Skipped when the
// source is already small AND modestly-resolved — see the
// COMPRESS_SKIP_BYTES guard.
//
// Returns:
//   - `File` — the compressed JPEG (also when the source was a
//     PNG/HEIC etc., since we re-encode to JPEG for downstream
//     consistency).
//   - `null` — when no compression was needed.
//
// Throws when the canvas isn't available or compression fails to
// produce a result that fits the cap. Callers display the message
// directly.

const COMPRESS_SKIP_BYTES = 1 * 1024 * 1024;
const MAX_LONGEST_EDGE = 1920;
// Quality fallback ladder. canvas.toBlob output is content-dependent
// (noisy / high-detail photos compress worse), so multiple steps help.
const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image."));
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

function jpegNameOf(original: string | undefined): string {
  const base = (original ?? "").replace(/\.[A-Za-z0-9]+$/, "");
  return `${base || "photo"}.jpg`;
}

export async function maybeCompressImage(
  file: File,
  maxBytes: number,
): Promise<File | null> {
  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const longestEdge = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.size <= COMPRESS_SKIP_BYTES && longestEdge <= MAX_LONGEST_EDGE) {
    return null;
  }

  const scale =
    longestEdge > MAX_LONGEST_EDGE ? MAX_LONGEST_EDGE / longestEdge : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable.");
  }
  ctx.drawImage(img, 0, 0, w, h);

  for (const quality of QUALITY_LADDER) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob) continue;
    if (blob.size <= maxBytes) {
      return new File([blob], jpegNameOf(file.name), {
        type: "image/jpeg",
      });
    }
  }
  throw new Error("Image too large even after compression.");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
