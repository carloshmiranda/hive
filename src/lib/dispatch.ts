import { getGitHubToken } from "./github-app";
import { cacheGet, cacheSet, cacheDel } from "./redis-cache";

const COOLDOWN_HOURS = 2;
const COOLDOWN_TTL_SECONDS = COOLDOWN_HOURS * 60 * 60;

function cooldownKey(itemId: string): string {
  return `fail:${itemId}`;
}

/**
 * Track a backlog item as recently failed with cooldown period.
 * Stored in Redis with TTL — survives Vercel redeploys.
 * Falls back to no-op if Redis is unavailable.
 */
export async function trackFailedBacklogItem(itemId: string, attemptCount: number = 1): Promise<void> {
  await cacheSet(cooldownKey(itemId), { attemptCount, failedAt: Date.now() }, COOLDOWN_TTL_SECONDS);
}

/**
 * Check if a backlog item is in cooldown period.
 * Returns false (allow dispatch) if Redis is unavailable.
 */
export async function isBacklogItemInCooldown(itemId: string): Promise<boolean> {
  const entry = await cacheGet<{ attemptCount: number; failedAt: number }>(cooldownKey(itemId));
  return entry !== null;
}

/**
 * Reset cooldown for a successfully dispatched backlog item.
 */
export async function resetBacklogItemCooldown(itemId: string): Promise<void> {
  await cacheDel(cooldownKey(itemId));
}

/**
 * @deprecated No-op — TTL-based Redis expiry handles cleanup automatically.
 */
export function cleanupFailedItemsCache(): void {
  // Redis TTL handles expiry — nothing to do
}

/**
 * @deprecated Returns empty array — Redis doesn't support scanning all keys efficiently on free tier.
 * Use the dispatch route's per-item cooldown check instead.
 */
export async function getFailedItemsInCooldown(): Promise<string[]> {
  return [];
}

/**
 * Dispatch a repository_dispatch event to trigger GitHub Actions workflows.
 * Reads the GitHub PAT from settings (encrypted in DB), falling back to env var.
 *
 * Used by: approval side effects, evolver proposals, webhook handlers.
 */
export async function dispatchEvent(eventType: string, payload: Record<string, any>) {
  try {
    // Try settings table first (works on Vercel), fall back to env var (works in GitHub Actions)
    const ghPat = await getGitHubToken() || process.env.GH_PAT;
    const ghRepo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";
    if (!ghPat) {
      console.warn(`dispatchEvent(${eventType}): no github_token in settings or GH_PAT env var`);
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${ghRepo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghPat}`,
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
