import { getSettingValue } from "@/lib/settings";

async function neonApi(path: string, method = "GET", body?: any) {
  const token = await getSettingValue("neon_api_key");
  if (!token) throw new Error("Neon API key not configured. Add it in Hive Settings.");

  const res = await fetch(`https://console.neon.tech/api/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Neon API ${method} ${path}: ${res.status} — ${err}`);
  }
  return res.json();
}

export async function createProject(slug: string) {
  const result = await neonApi("/projects", "POST", {
    project: {
      name: `hive-${slug}`,
      pg_version: 16,
      region_id: "aws-eu-central-1", // Frankfurt — closest available to Portugal
    },
  });

  // Extract connection URI from the response
  const connUri = result.connection_uris?.[0]?.connection_uri;
  return {
    projectId: result.project.id,
    connectionUri: connUri,
    host: result.endpoints?.[0]?.host,
  };
}

export async function deleteProject(projectId: string) {
  return neonApi(`/projects/${projectId}`, "DELETE");
}

export async function getProject(projectId: string) {
  return neonApi(`/projects/${projectId}`);
}

export async function listProjects() {
  return neonApi("/projects");
}
