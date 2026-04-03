/**
 * Vercel Blob storage wrapper for large research content.
 *
 * Strategy: If content exceeds BLOB_SIZE_THRESHOLD_BYTES and BLOB_READ_WRITE_TOKEN
 * is configured, upload to Blob and return a {_blob_url: "..."} marker object.
 * Callers transparently resolve markers by calling resolveBlobContent().
 *
 * Graceful fallback: if the env var is absent, returns null (caller stores in DB as usual).
 */

import { put, del } from "@vercel/blob";

// Store in blob if content string exceeds 100KB
const BLOB_SIZE_THRESHOLD_BYTES = 100 * 1024;

/** Type guard: is this JSONB content a blob URL marker? */
export function isBlobMarker(content: unknown): content is { _blob_url: string } {
  return (
    typeof content === "object" &&
    content !== null &&
    "_blob_url" in content &&
    typeof (content as Record<string, unknown>)._blob_url === "string"
  );
}

/**
 * Upload content to Vercel Blob if it exceeds the size threshold.
 * Returns the blob URL, or null if blob storage is not configured or content is small.
 */
export async function uploadIfLarge(
  content: string,
  pathPrefix: string
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  if (content.length < BLOB_SIZE_THRESHOLD_BYTES) return null;

  try {
    const { url } = await put(`${pathPrefix}/${Date.now()}.json`, content, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: true,
    });
    return url;
  } catch (e) {
    console.warn("[blob-storage] upload failed, falling back to DB storage:", e);
    return null;
  }
}

/**
 * Resolve a content value that may be a blob marker or raw JSONB.
 * If marker: fetch from Blob and parse. If raw: return as-is.
 */
export async function resolveBlobContent(content: unknown): Promise<unknown> {
  if (!isBlobMarker(content)) return content;

  try {
    const res = await fetch(content._blob_url);
    if (!res.ok) {
      console.warn(`[blob-storage] fetch failed (${res.status}): ${content._blob_url}`);
      return content; // return marker, caller decides what to do
    }
    return await res.json();
  } catch (e) {
    console.warn("[blob-storage] resolve failed:", e);
    return content;
  }
}

/**
 * Delete a blob by URL. No-op if not a blob URL or token missing.
 */
export async function deleteBlob(url: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await del(url);
  } catch (e) {
    console.warn("[blob-storage] delete failed:", e);
  }
}
