import { getSettingValue } from "@/lib/settings";

async function vercel(path: string, method = "GET", body?: any) {
  // Batch fetch both settings to reduce Redis calls from 2 to 1 HTTP request
  const [token, teamId] = await Promise.all([
    getSettingValue("vercel_token"),
    getSettingValue("vercel_team_id")
  ]);

  if (!token) throw new Error("Vercel token not configured. Add it in Hive Settings.");

  const separator = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com${path}${teamId ? `${separator}teamId=${teamId}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel API ${method} ${path}: ${res.status} — ${err}`);
  }
  return res.json();
}

export async function createProject(slug: string, githubRepo: string) {
  // Note: The vercel() function already batches vercel_token + vercel_team_id
  // This additional call would benefit from batching if called together with vercel()
  const owner = await getSettingValue("github_owner");
  return vercel("/v10/projects", "POST", {
    name: slug,
    framework: "nextjs",
    gitRepository: {
      repo: `${owner}/${slug}`,
      type: "github",
    },
    buildCommand: "npm run build",
    outputDirectory: ".next",
  });
}

export async function setEnvVars(projectId: string, envs: Array<{ key: string; value: string; target?: string[] }>) {
  return vercel(`/v10/projects/${projectId}/env`, "POST",
    envs.map(e => ({
      key: e.key,
      value: e.value,
      type: "encrypted",
      target: e.target || ["production", "preview"],
    }))
  );
}

export async function triggerDeploy(projectId: string) {
  // Create a deployment hook or trigger via API
  return vercel(`/v13/deployments`, "POST", {
    name: projectId,
    project: projectId,
    target: "production",
  });
}

export async function deleteProject(projectId: string) {
  return vercel(`/v9/projects/${projectId}`, "DELETE");
}

export async function getProject(projectId: string) {
  return vercel(`/v9/projects/${projectId}`);
}

export async function addDomain(projectId: string, domain: string) {
  return vercel(`/v10/projects/${projectId}/domains`, "POST", { name: domain });
}

export async function getDomains(projectId: string): Promise<Array<{ name: string; verified: boolean; configured: boolean }>> {
  const res = await vercel(`/v9/projects/${projectId}/domains`);
  return (res.domains || []).map((d: any) => ({
    name: d.name,
    verified: d.verified ?? false,
    configured: d.configured ?? false,
  }));
}

export async function removeDomain(projectId: string, domain: string) {
  return vercel(`/v9/projects/${projectId}/domains/${domain}`, "DELETE");
}

export async function enableWebAnalytics(projectId: string) {
  return vercel(`/v1/web-analytics/project/${projectId}`, "POST", { enabledAt: new Date().toISOString() });
}

export async function getLatestDeployment(projectId: string): Promise<{ id: string; url: string; state: string; readyState: string; createdAt: number } | null> {
  const res = await vercel(`/v6/deployments?projectId=${projectId}&limit=1&target=production`);
  const dep = res.deployments?.[0];
  if (!dep) return null;
  return { id: dep.uid, url: dep.url, state: dep.state, readyState: dep.readyState, createdAt: dep.createdAt };
}

export async function listProjectsForRepo(repoFullName: string): Promise<Array<{ id: string; name: string; updatedAt: number; repo?: string }>> {
  // Vercel API doesn't support filtering by repo directly.
  // Fetch all projects and filter by gitRepository.repo match.
  const res = await vercel(`/v9/projects?limit=100`);
  const repoLower = repoFullName.toLowerCase();
  return (res.projects || [])
    .filter((p: any) => {
      const linked = p.link?.repo?.toLowerCase() || p.gitRepository?.repo?.toLowerCase() || "";
      return linked === repoLower || linked.endsWith(`/${repoLower.split("/").pop()}`);
    })
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      repo: p.link?.repo || p.gitRepository?.repo,
    }));
}

export async function unlinkGitRepo(projectId: string): Promise<void> {
  // Remove the git repository link so the project stops auto-deploying
  await vercel(`/v9/projects/${projectId}/link`, "DELETE");
}

export async function removeGitLink(projectId: string): Promise<boolean> {
  // Alternative: try unlinking, return false on error (non-critical)
  try {
    await unlinkGitRepo(projectId);
    return true;
  } catch {
    return false;
  }
}

// ── Vercel Marketplace: Neon Postgres provisioning ──

/**
 * Find the Neon integration configuration ID on this team.
 * Required before creating a Neon store via the Marketplace API.
 */
export async function findNeonIntegrationConfig(): Promise<{ id: string; slug: string } | null> {
  try {
    // The API requires view=account to list team-level integration configurations
    const res = await vercel("/v1/integrations/configurations?view=account");
    const configs = Array.isArray(res) ? res : res.configurations || [];
    const neon = configs.find((c: any) =>
      c.slug === "neon" ||
      c.integration?.slug === "neon" ||
      c.integrationSlug === "neon" ||
      (c.slug || "").toLowerCase().includes("neon") ||
      (c.integration?.name || "").toLowerCase().includes("neon")
    );
    if (!neon) return null;
    return { id: neon.id, slug: neon.slug || neon.integration?.slug || "neon" };
  } catch {
    return null;
  }
}

/**
 * Discover the Neon Postgres product ID/slug for this integration configuration.
 * Needed for the store creation API — product slugs vary by integration.
 */
async function discoverNeonProductSlug(configId: string): Promise<string> {
  try {
    const res = await vercel(`/v1/integrations/configurations/${configId}/products`);
    const products = Array.isArray(res) ? res : res.products || [];
    // Find a Postgres-related product — prefer ID (iap_*) over slug
    const pg = products.find((p: any) =>
      (p.slug || p.id || "").toLowerCase().includes("postgres") ||
      (p.name || "").toLowerCase().includes("postgres") ||
      (p.slug || p.id || "").toLowerCase().includes("neon")
    );
    if (pg) return pg.id || pg.slug;
  } catch (e: any) {
    console.warn(`[vercel] Could not discover Neon products for ${configId}: ${e.message}`);
  }
  // Fallback: known Neon product slug from Vercel Marketplace
  return "neon";
}

/**
 * Provision a Neon Postgres database via Vercel Marketplace API.
 * This creates a Neon store and auto-injects DATABASE_URL into the Vercel project.
 * Works with Vercel-managed Neon — no separate Neon API key needed.
 *
 * Uses POST /v1/storage/stores/integration/direct (auto-discovers free billing plan).
 * Fallback: POST /v1/integrations/store.
 */
export async function provisionNeonStore(
  projectId: string,
  name: string,
): Promise<{ storeId: string; status: string } | null> {
  // Step 1: Find Neon integration config
  const neonConfig = await findNeonIntegrationConfig();
  if (!neonConfig) {
    throw new Error("Neon integration not found on Vercel team. Install it from vercel.com/marketplace/neon");
  }

  // Step 2: Discover the product slug
  const productSlug = await discoverNeonProductSlug(neonConfig.id);

  // Step 3: Create the store via Marketplace direct provisioning API
  // Region must match the existing Neon setup (fra1 = Frankfurt)
  const storePayload = {
    name,
    integrationConfigurationId: neonConfig.id,
    integrationProductIdOrSlug: productSlug,
    metadata: { region: "fra1" },
    source: "marketplace",
  };

  let store: any;
  try {
    store = await vercel("/v1/storage/stores/integration/direct", "POST", storePayload);
  } catch (e: any) {
    // Fallback: try the older /v1/integrations/store endpoint
    console.warn(`[vercel] /v1/storage/stores/integration/direct failed: ${e.message}, trying fallback`);
    try {
      store = await vercel("/v1/integrations/store", "POST", storePayload);
    } catch (e2: any) {
      // Final fallback: try POST /v1/stores
      console.warn(`[vercel] /v1/integrations/store failed: ${e2.message}, trying /v1/stores`);
      store = await vercel("/v1/stores", "POST", storePayload);
    }
  }

  const storeData = store.store || store;
  const storeId = storeData.id || storeData.externalResourceId;

  if (!storeId) {
    throw new Error(`Neon store creation returned no ID: ${JSON.stringify(store).slice(0, 300)}`);
  }

  // Step 4: Connect store to the project (auto-injects DATABASE_URL env var)
  try {
    // Primary: installations/{configId}/resources/{resourceId}/connections
    await vercel(`/v1/integrations/installations/${neonConfig.id}/resources/${storeId}/connections`, "POST", {
      projectId,
    });
  } catch (e: any) {
    // Fallback: storage/stores/{storeId}/connections
    if (!e.message?.includes("already")) {
      try {
        await vercel(`/v1/storage/stores/${storeId}/connections`, "POST", {
          projectId,
          environmentVariableSuffix: "",
        });
      } catch (e2: any) {
        if (!e2.message?.includes("already")) {
          console.warn(`[vercel] Could not connect store ${storeId} to project ${projectId}: ${e.message} / ${e2.message}`);
        }
      }
    }
  }

  return { storeId, status: storeData.status || "created" };
}

/**
 * Check if a Vercel project has a specific env var set.
 */
export async function hasEnvVar(projectId: string, key: string): Promise<boolean> {
  try {
    const res = await vercel(`/v9/projects/${projectId}/env`);
    return (res.envs || []).some((e: { key: string }) => e.key === key);
  } catch {
    return false;
  }
}

/**
 * Get the value of a Vercel project env var (decrypted).
 */
export async function getEnvVar(projectId: string, key: string): Promise<string | null> {
  try {
    const res = await vercel(`/v9/projects/${projectId}/env`);
    const env = (res.envs || []).find((e: { key: string }) => e.key === key);
    if (!env) return null;
    // Fetch decrypted value
    const detail = await vercel(`/v9/projects/${projectId}/env/${env.id}`);
    return detail.value || null;
  } catch {
    return null;
  }
}

export async function redeployProduction(projectId: string): Promise<{ id: string; url: string } | null> {
  // Get the latest deployment and redeploy it
  const dep = await getLatestDeployment(projectId);
  if (!dep) return null;

  // Use the Vercel redeploy API (v13/deployments/{id}/redeploy)
  try {
    const res = await vercel(`/v13/deployments/${dep.id}/redeploy`, "POST", { target: "production" });
    return { id: res.id || res.uid, url: res.url };
  } catch {
    // Fallback: some Vercel plans don't support redeploy API
    return null;
  }
}
