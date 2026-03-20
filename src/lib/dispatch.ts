import { getSettingValue } from "./settings";

/**
 * Dispatch a repository_dispatch event to trigger GitHub Actions workflows.
 * Reads the GitHub PAT from settings (encrypted in DB), falling back to env var.
 *
 * Used by: approval side effects, evolver proposals, webhook handlers.
 */
export async function dispatchEvent(eventType: string, payload: Record<string, any>) {
  try {
    // Try settings table first (works on Vercel), fall back to env var (works in GitHub Actions)
    const ghPat = await getSettingValue("github_token") || process.env.GH_PAT;
    const ghRepo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";
    if (!ghPat) {
      console.warn(`dispatchEvent(${eventType}): no github_token in settings or GH_PAT env var`);
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${ghRepo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `token ${ghPat}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    });
    if (!res.ok) {
      console.error(`dispatchEvent(${eventType}): ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`dispatchEvent(${eventType}): ${(err as Error).message}`);
  }
}
