/**
 * Vercel Edge Config integration for sub-ms feature flag reads.
 *
 * Why Edge Config vs Redis vs Neon:
 * - Neon: ~50ms round-trip, costs CU-hours on the free tier
 * - Redis (Upstash): ~5ms, good for mutable state
 * - Edge Config: <1ms, globally replicated, ideal for rarely-changed boolean flags
 *
 * Flags stored here:
 *   dispatch_paused      — kill switch for all agent dispatches
 *   maintenance_mode     — pause all public-facing features (future use)
 *
 * Fallback: if EDGE_CONFIG env var is not set, falls back to Neon settings table
 * so local dev and non-Edge-Config deployments work unchanged.
 *
 * Writing requires the Vercel API (not the Edge Config SDK which is read-only).
 * The Edge Config ID is parsed from the EDGE_CONFIG connection string.
 */

import { createClient } from "@vercel/edge-config";
import { getDb } from "@/lib/db";

// Flags that live in Edge Config (subset of settings table keys)
export const EDGE_CONFIG_FLAGS = ["dispatch_paused", "maintenance_mode"] as const;
export type EdgeConfigFlag = (typeof EDGE_CONFIG_FLAGS)[number];

// Numeric thresholds in Edge Config — configurable without code deploys.
// All have hardcoded defaults so the system works with no Edge Config set up.
export const EDGE_CONFIG_THRESHOLDS = {
  budget_throttle_high_pct:  70,  // claude_pct above which dispatch is penalized
  budget_throttle_stop_pct:  90,  // claude_pct above which health-gate returns "stop"
  max_companies_active:       2,  // max companies running brain agents simultaneously
  spawn_engineer_threshold:   1,  // min engineering tasks before spawning Engineer
  playbook_min_score:        40,  // min confidence*100 for playbook entries shown in context
} as const;
export type EdgeConfigThreshold = keyof typeof EDGE_CONFIG_THRESHOLDS;

// Lazy singleton — only created if EDGE_CONFIG env var is set
let client: ReturnType<typeof createClient> | null = null;
function getEdgeConfigClient() {
  if (!process.env.EDGE_CONFIG) return null;
  if (!client) client = createClient(process.env.EDGE_CONFIG);
  return client;
}

/**
 * Extracts the Edge Config ID from the connection string.
 * Format: https://edge-config.vercel.com/{id}?token={token}
 */
function parseEdgeConfigId(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a boolean flag from Edge Config.
 * Falls back to Neon settings table if Edge Config is not configured.
 */
export async function getEdgeFlag(flag: EdgeConfigFlag): Promise<boolean> {
  const ec = getEdgeConfigClient();
  if (ec) {
    try {
      const value = await ec.get<boolean | string>(flag);
      if (value === null || value === undefined) return false;
      return value === true || value === "true";
    } catch (e) {
      // Edge Config unavailable — fall through to Neon
      console.warn(`[edge-config] get(${flag}) failed, falling back to Neon:`, e);
    }
  }

  // Fallback: Neon direct read (no Redis — this is already fast enough for the fallback case)
  const sql = getDb();
  const [row] = await sql`
    SELECT value FROM settings WHERE key = ${flag} LIMIT 1
  `.catch(() => [] as any[]);
  return row?.value === "true";
}

/**
 * Convenience: get dispatch_paused flag.
 * This is the hot path — called at the start of every sentinel run.
 */
export async function isDispatchPaused(): Promise<boolean> {
  return getEdgeFlag("dispatch_paused");
}

/**
 * Read a numeric threshold from Edge Config.
 * Falls back to the hardcoded default if Edge Config is unavailable or key is missing.
 * <1ms when Edge Config is configured; ~50ms fallback to Neon is intentionally avoided.
 */
export async function getThreshold(key: EdgeConfigThreshold): Promise<number> {
  const defaultValue = EDGE_CONFIG_THRESHOLDS[key];
  const ec = getEdgeConfigClient();
  if (ec) {
    try {
      const value = await ec.get<number | string>(key);
      if (value !== null && value !== undefined) {
        const parsed = Number(value);
        if (!isNaN(parsed)) return parsed;
      }
    } catch {
      // Edge Config unavailable — use default
    }
  }
  return defaultValue;
}

/**
 * Sync a flag value to Edge Config.
 * Called from the settings POST handler after writing to Neon.
 *
 * Requires:
 *   EDGE_CONFIG env var — connection string (provides the config ID)
 *   VERCEL_TOKEN or vercel_token setting — for Vercel API auth
 *
 * Silently no-ops if Edge Config is not configured.
 */
export async function syncFlagToEdgeConfig(
  flag: EdgeConfigFlag,
  value: string | boolean,
  vercelToken?: string | null
): Promise<{ synced: boolean; error?: string }> {
  const connectionString = process.env.EDGE_CONFIG;
  if (!connectionString) return { synced: false };

  const edgeConfigId = parseEdgeConfigId(connectionString);
  if (!edgeConfigId) {
    return { synced: false, error: "Could not parse Edge Config ID from EDGE_CONFIG env var" };
  }

  // Resolve Vercel token: param > env var > settings table
  const token = vercelToken
    ?? process.env.VERCEL_TOKEN
    ?? process.env.VERCEL_API_TOKEN;
  if (!token) {
    return { synced: false, error: "No Vercel API token available for Edge Config sync" };
  }

  // Normalize value: store booleans as booleans in Edge Config
  const normalizedValue = value === "true" || value === true;

  try {
    const res = await fetch(
      `https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [{ operation: "upsert", key: flag, value: normalizedValue }],
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      return { synced: false, error: `Vercel API ${res.status}: ${body}` };
    }

    // Bust the Edge Config client's internal cache
    client = null;

    return { synced: true };
  } catch (e: any) {
    return { synced: false, error: e?.message ?? "Unknown error" };
  }
}

/**
 * Sync ALL Edge Config flags from Neon settings.
 * Useful for initial setup / reconciliation after config drift.
 */
export async function syncAllFlagsToEdgeConfig(
  vercelToken?: string | null
): Promise<Record<EdgeConfigFlag, { synced: boolean; error?: string }>> {
  const connectionString = process.env.EDGE_CONFIG;
  const results = {} as Record<EdgeConfigFlag, { synced: boolean; error?: string }>;

  if (!connectionString) {
    for (const flag of EDGE_CONFIG_FLAGS) results[flag] = { synced: false };
    return results;
  }

  const edgeConfigId = parseEdgeConfigId(connectionString);
  if (!edgeConfigId) {
    for (const flag of EDGE_CONFIG_FLAGS) {
      results[flag] = { synced: false, error: "Could not parse Edge Config ID" };
    }
    return results;
  }

  const token = vercelToken ?? process.env.VERCEL_TOKEN ?? process.env.VERCEL_API_TOKEN;
  if (!token) {
    for (const flag of EDGE_CONFIG_FLAGS) {
      results[flag] = { synced: false, error: "No Vercel API token" };
    }
    return results;
  }

  // Fetch current flag values from Neon
  const sql = getDb();
  const flagKeys = [...EDGE_CONFIG_FLAGS] as string[];
  const rows = await sql`
    SELECT key, value FROM settings
    WHERE key = ANY(${flagKeys})
  `.catch(() => []) as Array<{ key: string; value: string }>;

  const neonValues = new Map(rows.map(r => [r.key, r.value]));

  // Build batch items
  const items = EDGE_CONFIG_FLAGS.map(flag => ({
    operation: "upsert" as const,
    key: flag,
    value: neonValues.get(flag) === "true",
  }));

  try {
    const res = await fetch(
      `https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      for (const flag of EDGE_CONFIG_FLAGS) {
        results[flag] = { synced: false, error: `Vercel API ${res.status}: ${body}` };
      }
    } else {
      client = null;
      for (const flag of EDGE_CONFIG_FLAGS) results[flag] = { synced: true };
    }
  } catch (e: any) {
    for (const flag of EDGE_CONFIG_FLAGS) {
      results[flag] = { synced: false, error: e?.message ?? "Unknown error" };
    }
  }

  return results;
}
