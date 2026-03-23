import { getSettingValue } from "@/lib/settings";

async function vercel(path: string, method = "GET", body?: any) {
  const token = await getSettingValue("vercel_token");
  if (!token) throw new Error("Vercel token not configured. Add it in Hive Settings.");

  const teamId = await getSettingValue("vercel_team_id");
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
