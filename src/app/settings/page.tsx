"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

type Setting = {
  key: string;
  value: string;
  is_set: boolean;
  is_secret: boolean;
  updated_at: string | null;
};

const LABELS: Record<string, { label: string; placeholder: string; help: string }> = {
  neon_api_key: { label: "Neon API Key", placeholder: "neon_...", help: "console.neon.tech → Account → API Keys" },
  vercel_token: { label: "Vercel Token", placeholder: "vercel_...", help: "vercel.com/account/tokens" },
  vercel_team_id: { label: "Vercel Team ID", placeholder: "team_...", help: "Optional — only if using a team account" },
  github_token: { label: "GitHub PAT", placeholder: "ghp_...", help: "github.com/settings/tokens — scopes: repo, workflow" },
  github_owner: { label: "GitHub Owner", placeholder: "carlos-miranda", help: "Your GitHub username for new repos" },
  stripe_secret_key: { label: "Stripe Secret Key", placeholder: "sk_live_...", help: "dashboard.stripe.com/apikeys — single account, products tagged per company" },
  resend_api_key: { label: "Resend API Key", placeholder: "re_...", help: "resend.com/api-keys" },
  resend_domain: { label: "Resend Domain", placeholder: "hive.yourdomain.com", help: "Verified sending domain — companies share it with different from addresses" },
  google_search_console_key: { label: "Google Search Console", placeholder: "service account JSON key", help: "For SEO tracking. Growth agent reads impressions/clicks per company property." },
  digest_email: { label: "Digest Email", placeholder: "you@example.com", help: "Where Hive sends your daily morning digest" },
  notification_email: { label: "Notification Email", placeholder: "you@example.com", help: "For urgent escalations (can be same as digest)" },
  gemini_api_key: { label: "Gemini API Key", placeholder: "AIza...", help: "aistudio.google.com/apikey — free tier: Growth, Outreach agents" },
  groq_api_key: { label: "Groq API Key", placeholder: "gsk_...", help: "console.groq.com/keys — free tier: Ops agent" },
};

const GROUPS = [
  { title: "Infrastructure", keys: ["vercel_token", "vercel_team_id", "neon_api_key", "github_token", "github_owner"] },
  { title: "Revenue & Analytics", keys: ["stripe_secret_key", "google_search_console_key"] },
  { title: "Communications", keys: ["resend_api_key", "resend_domain", "digest_email", "notification_email"] },
  { title: "AI Providers", keys: ["gemini_api_key", "groq_api_key"] },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  // Import state
  const [importUrl, setImportUrl] = useState("");
  const [importName, setImportName] = useState("");
  const [importSlug, setImportSlug] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const { data } = await res.json();
      setSettings(data);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const saveSetting = async (key: string) => {
    const value = edits[key];
    if (value === undefined) return;

    setSaving(p => ({ ...p, [key]: true }));
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });

    setSaving(p => ({ ...p, [key]: false }));
    if (res.ok) {
      setSaved(p => ({ ...p, [key]: true }));
      setEdits(p => { const n = { ...p }; delete n[key]; return n; });
      setTimeout(() => setSaved(p => ({ ...p, [key]: false })), 2000);
      fetchSettings();
    }
  };

  const handleImport = async () => {
    if (!importName || !importSlug) return;
    setImporting(true);
    const res = await fetch("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: importUrl.includes("github.com") ? "github_repo" : "manual",
        source_url: importUrl || null,
        name: importName,
        slug: importSlug,
      }),
    });
    setImporting(false);
    if (res.ok) {
      setImportResult(`${importName} queued for import`);
      setImportUrl(""); setImportName(""); setImportSlug("");
      setTimeout(() => setImportResult(null), 4000);
    } else {
      setImportResult("Import failed — check the console");
      setTimeout(() => setImportResult(null), 4000);
    }
  };

  const setCount = settings.filter(s => s.is_set).length;
  const totalCount = settings.length;

  return (
    <div style={{ fontFamily: "var(--hive-sans)", background: "var(--hive-bg)", minHeight: "100vh", padding: "24px 28px", maxWidth: 720, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "var(--hive-text-secondary)", textDecoration: "none", fontSize: 13 }}>← Dashboard</Link>
          <span style={{ color: "var(--hive-text-dim)" }}>/</span>
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--hive-text)" }}>Settings</span>
        </div>
        <div style={{ fontFamily: "var(--hive-mono)", fontSize: 12, color: setCount === totalCount ? "var(--hive-green)" : "var(--hive-amber)" }}>
          {setCount}/{totalCount} configured
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--hive-text-secondary)", fontFamily: "var(--hive-mono)", fontSize: 13, padding: 40, textAlign: "center" }}>Loading settings...</div>
      ) : (
        <>
          {GROUPS.map(group => (
            <div key={group.title} style={{ marginBottom: 32 }}>
              <div style={{
                fontFamily: "var(--hive-mono)", fontSize: 11, fontWeight: 500, color: "var(--hive-text-secondary)",
                letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12, paddingBottom: 8,
                borderBottom: "1px solid var(--hive-border)"
              }}>
                {group.title}
              </div>

              {group.keys.map(key => {
                const setting = settings.find(s => s.key === key);
                const meta = LABELS[key] || { label: key, placeholder: "", help: "" };
                const isEditing = edits[key] !== undefined;
                const isSaving = saving[key];
                const isSaved = saved[key];

                return (
                  <div key={key} style={{
                    padding: "14px 0", borderBottom: "1px solid var(--hive-border-subtle)",
                    display: "flex", alignItems: "flex-start", gap: 16
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--hive-text)", marginBottom: 2 }}>
                        {meta.label}
                        {setting?.is_set && (
                          <span style={{
                            marginLeft: 8, fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                            padding: "1px 6px", borderRadius: 4,
                            background: "var(--hive-green-bg)", color: "var(--hive-green)", border: "1px solid var(--hive-green-border)"
                          }}>SET</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", marginBottom: 8 }}>{meta.help}</div>

                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type={setting?.is_secret ? "password" : "text"}
                          placeholder={setting?.is_set ? setting.value : meta.placeholder}
                          value={edits[key] ?? ""}
                          onChange={e => setEdits(p => ({ ...p, [key]: e.target.value }))}
                          onKeyDown={e => { if (e.key === "Enter") saveSetting(key); }}
                          style={{
                            flex: 1, padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)",
                            background: "var(--hive-surface)", border: "1px solid var(--hive-border)",
                            borderRadius: 6, color: "var(--hive-text)", outline: "none",
                            transition: "border-color 0.15s",
                          }}
                          onFocus={e => { e.target.style.borderColor = "var(--hive-amber-border)"; }}
                          onBlur={e => { e.target.style.borderColor = "var(--hive-border)"; }}
                        />
                        {isEditing && (
                          <button
                            onClick={() => saveSetting(key)}
                            disabled={isSaving}
                            style={{
                              padding: "8px 16px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, border: "1px solid var(--hive-green-border)",
                              background: isSaving ? "var(--hive-green-bg)" : "var(--hive-green-bg)",
                              color: "var(--hive-green)", cursor: isSaving ? "wait" : "pointer",
                              letterSpacing: "0.04em", transition: "all 0.15s"
                            }}
                          >
                            {isSaving ? "..." : "SAVE"}
                          </button>
                        )}
                        {isSaved && (
                          <span style={{ fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-green)" }}>Saved</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* Import project section */}
          <div style={{ marginBottom: 32 }}>
            <div style={{
              fontFamily: "var(--hive-mono)", fontSize: 11, fontWeight: 500, color: "var(--hive-text-secondary)",
              letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12, paddingBottom: 8,
              borderBottom: "1px solid var(--hive-border)"
            }}>
              Import project
            </div>

            <div style={{ padding: 20, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>
              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
                Import an existing project into Hive. For GitHub repos, Hive scans the codebase, detects tech stack, and creates an onboarding plan.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <input value={importName} onChange={e => {
                  setImportName(e.target.value);
                  if (!importSlug || importSlug === importName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) {
                    setImportSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                  }
                }} placeholder="Company name (e.g. Flolio)" style={{
                  padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                  border: "1px solid var(--hive-border)", borderRadius: 6, color: "var(--hive-text)", outline: "none",
                }} />
                <input value={importSlug} onChange={e => setImportSlug(e.target.value)} placeholder="slug (e.g. flolio)" style={{
                  padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                  border: "1px solid var(--hive-border)", borderRadius: 6, color: "var(--hive-text)", outline: "none",
                }} />
              </div>
              <input value={importUrl} onChange={e => setImportUrl(e.target.value)}
                placeholder="GitHub URL (optional for manual imports)"
                style={{
                  width: "100%", padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                  border: "1px solid var(--hive-border)", borderRadius: 6, color: "var(--hive-text)", outline: "none", marginBottom: 14,
                }} />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={handleImport} disabled={!importName || !importSlug || importing} style={{
                  padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, borderRadius: 6,
                  border: "1px solid var(--hive-blue-border)", background: "var(--hive-blue-bg)",
                  color: "var(--hive-blue)", cursor: importName && importSlug ? "pointer" : "default",
                  opacity: importName && importSlug ? 1 : 0.4,
                }}>Scan &amp; Import</button>
                {importResult && (
                  <span style={{ fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-green)" }}>{importResult}</span>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <div style={{
        marginTop: 20, padding: 16, background: "var(--hive-surface)", borderRadius: 10,
        border: "1px solid var(--hive-border)", fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.7
      }}>
        All secrets are encrypted with AES-256-GCM before storage. The orchestrator decrypts them at runtime using your ENCRYPTION_KEY environment variable. Credential values are never exposed — only the last 4 characters are shown.
      </div>
    </div>
  );
}
