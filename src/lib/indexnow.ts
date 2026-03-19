// IndexNow protocol — instant re-indexing for Bing, Yandex, and 4 other engines
// Google does NOT support IndexNow as of March 2026
// Free, no rate limit issues at our scale (10,000 URLs/day max)

import { getSettingValue } from "./settings";

export async function submitToIndexNow(urls: string | string[]): Promise<{ submitted: number; errors: string[] }> {
  const key = await getSettingValue("indexnow_key");
  if (!key) return { submitted: 0, errors: ["indexnow_key not configured in settings"] };

  const urlList = Array.isArray(urls) ? urls : [urls];
  if (urlList.length === 0) return { submitted: 0, errors: [] };

  const host = new URL(urlList[0]).host;
  const errors: string[] = [];

  // Submit to the shared endpoint (distributes to all participating engines)
  try {
    const res = await fetch("https://api.indexnow.org/IndexNow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `https://${host}/${key}.txt`,
        urlList,
      }),
    });

    if (!res.ok && res.status !== 202) {
      errors.push(`IndexNow API returned ${res.status}: ${await res.text()}`);
    }
  } catch (e: any) {
    errors.push(`IndexNow submission failed: ${e.message}`);
  }

  return { submitted: errors.length === 0 ? urlList.length : 0, errors };
}

// Generate the key verification file content
// Place at https://yoursite.com/{key}.txt
export function generateKeyFile(key: string): string {
  return key;
}
