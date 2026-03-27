import { getGitHubToken } from "./github-app";

interface FailedBacklogItem {
  id: string;
  failedAt: number;
  cooldownHours: number;
  attemptCount: number;
}

// In-memory cache for failed backlog items (2h cooldown by default)
const failedItemsCache = new Map<string, FailedBacklogItem>();
const COOLDOWN_HOURS = 2;
const MAX_CACHE_SIZE = 1000;

/**
 * Track a backlog item as recently failed with cooldown period
 */
export function trackFailedBacklogItem(itemId: string, attemptCount: number = 1): void {
  const now = Date.now();
  failedItemsCache.set(itemId, {
    id: itemId,
    failedAt: now,
    cooldownHours: COOLDOWN_HOURS,
    attemptCount,
  });

  // Cleanup if cache gets too large
  if (failedItemsCache.size > MAX_CACHE_SIZE) {
    cleanupFailedItemsCache();
  }
}

/**
 * Check if a backlog item is in cooldown period
 */
export function isBacklogItemInCooldown(itemId: string): boolean {
  const failedItem = failedItemsCache.get(itemId);
  if (!failedItem) return false;

  const now = Date.now();
  const cooldownMs = failedItem.cooldownHours * 60 * 60 * 1000;
  return (now - failedItem.failedAt) < cooldownMs;
}

/**
 * Reset cooldown for a successfully dispatched backlog item
 */
export function resetBacklogItemCooldown(itemId: string): void {
  failedItemsCache.delete(itemId);
}

/**
 * Get failed items that are still in cooldown
 */
export function getFailedItemsInCooldown(): string[] {
  const now = Date.now();
  const inCooldown: string[] = [];

  for (const [itemId, failedItem] of failedItemsCache.entries()) {
    const cooldownMs = failedItem.cooldownHours * 60 * 60 * 1000;
    if ((now - failedItem.failedAt) < cooldownMs) {
      inCooldown.push(itemId);
    }
  }

  return inCooldown;
}

/**
 * Periodically clean up expired entries from failed items cache
 */
export function cleanupFailedItemsCache(): void {
  const now = Date.now();
  const expiredIds: string[] = [];

  for (const [itemId, failedItem] of failedItemsCache.entries()) {
    const cooldownMs = failedItem.cooldownHours * 60 * 60 * 1000;
    if ((now - failedItem.failedAt) >= cooldownMs) {
      expiredIds.push(itemId);
    }
  }

  for (const id of expiredIds) {
    failedItemsCache.delete(id);
  }
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
