/**
 * Hive Plugin Registry — extensible capability system for adding agent capabilities
 * without modifying core workflows.
 *
 * Plugins can add: new data sources, output channels, business models.
 * Enabled plugins are loaded from the hive_plugins DB table at runtime.
 */

import { getDb } from "@/lib/db";
import { HiveCapability } from "@/lib/hive-capabilities";

export interface HivePlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: HiveCapability[];
  dataSourceAdapters: string[];
  outputChannelAdapters: string[];
}

// Shape of the manifest JSONB stored in DB
export interface HivePluginManifest {
  capabilities?: HiveCapability[];
  dataSourceAdapters?: string[];
  outputChannelAdapters?: string[];
}

/**
 * Validate that a manifest has the required shape.
 * Returns an error string if invalid, or null if valid.
 */
export function validatePluginManifest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") {
    return "manifest must be a non-null object";
  }
  const m = manifest as Record<string, unknown>;

  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) {
      return "manifest.capabilities must be an array";
    }
    for (const cap of m.capabilities as unknown[]) {
      if (!cap || typeof cap !== "object") return "each capability must be an object";
      const c = cap as Record<string, unknown>;
      if (typeof c.id !== "string") return "capability.id must be a string";
      if (typeof c.endpoint !== "string") return "capability.endpoint must be a string";
      if (!["GET", "POST", "PATCH"].includes(c.method as string)) {
        return "capability.method must be GET, POST, or PATCH";
      }
      if (!["cron_secret", "oidc", "session"].includes(c.auth as string)) {
        return "capability.auth must be cron_secret, oidc, or session";
      }
      if (typeof c.description !== "string") return "capability.description must be a string";
      if (!Array.isArray(c.triggers)) return "capability.triggers must be an array";
      if (typeof c.params !== "object" || c.params === null) {
        return "capability.params must be an object";
      }
    }
  }

  if (m.dataSourceAdapters !== undefined) {
    if (!Array.isArray(m.dataSourceAdapters) || !m.dataSourceAdapters.every((s) => typeof s === "string")) {
      return "manifest.dataSourceAdapters must be an array of strings";
    }
  }

  if (m.outputChannelAdapters !== undefined) {
    if (!Array.isArray(m.outputChannelAdapters) || !m.outputChannelAdapters.every((s) => typeof s === "string")) {
      return "manifest.outputChannelAdapters must be an array of strings";
    }
  }

  return null;
}

/**
 * Load all enabled plugins from the DB and parse their manifests.
 */
export async function loadEnabledPlugins(): Promise<HivePlugin[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, name, version, enabled, manifest
    FROM hive_plugins
    WHERE enabled = true
    ORDER BY created_at ASC
  `;

  return rows.map((row: Record<string, unknown>) => {
    const manifest = (row.manifest ?? {}) as HivePluginManifest;
    return {
      id: row.id as string,
      name: row.name as string,
      version: row.version as string,
      enabled: row.enabled as boolean,
      capabilities: (manifest.capabilities ?? []) as HiveCapability[],
      dataSourceAdapters: manifest.dataSourceAdapters ?? [],
      outputChannelAdapters: manifest.outputChannelAdapters ?? [],
    };
  });
}
