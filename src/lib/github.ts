import { getSettingValue } from "@/lib/settings";

async function gh(path: string, method = "GET", body?: any) {
  const token = await getSettingValue("github_token");
  if (!token) throw new Error("GitHub token not configured. Add it in Hive Settings.");

  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${method} ${path}: ${res.status} — ${err}`);
  }
  return res.json();
}

export async function createRepo(slug: string, description: string) {
  const owner = await getSettingValue("github_owner");
  if (!owner) throw new Error("GitHub owner not configured. Add it in Hive Settings.");

  return gh("/user/repos", "POST", {
    name: slug,
    description,
    private: true,
    auto_init: false,
  });
}

export async function pushFile(owner: string, repo: string, path: string, content: string, message: string) {
  const encoded = Buffer.from(content).toString("base64");
  return gh(`/repos/${owner}/${repo}/contents/${path}`, "PUT", {
    message,
    content: encoded,
  });
}

export async function pushFiles(owner: string, repo: string, files: Array<{ path: string; content: string }>, message: string) {
  // Create a tree with all files, then a commit
  // Step 1: Create blobs
  const blobs = await Promise.all(
    files.map(f => gh(`/repos/${owner}/${repo}/git/blobs`, "POST", {
      content: f.content,
      encoding: "utf-8",
    }))
  );

  // Step 2: Create tree
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, "POST", {
    tree: files.map((f, i) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: blobs[i].sha,
    })),
  });

  // Step 3: Get default branch ref (might not exist yet)
  let parentSha: string | undefined;
  try {
    const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/main`);
    parentSha = ref.object.sha;
  } catch {
    // Repo is empty, no parent
  }

  // Step 4: Create commit
  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, "POST", {
    message,
    tree: tree.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  });

  // Step 5: Create or update ref
  if (parentSha) {
    await gh(`/repos/${owner}/${repo}/git/refs/heads/main`, "PATCH", { sha: commit.sha });
  } else {
    await gh(`/repos/${owner}/${repo}/git/refs`, "POST", { ref: "refs/heads/main", sha: commit.sha });
  }

  return commit;
}

export async function archiveRepo(owner: string, repo: string) {
  return gh(`/repos/${owner}/${repo}`, "PATCH", { archived: true });
}
