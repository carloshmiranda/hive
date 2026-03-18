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
};

const GROUPS = [
  { title: "Infrastructure", keys: ["vercel_token", "vercel_team_id", "neon_api_key", "github_token", "github_owner"] },
  { title: "Revenue & Analytics", keys: ["stripe_secret_key", "google_search_console_key"] },
  { title: "Communications", keys: ["resend_api_key", "resend_domain", "digest_email", "notification_email"] },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

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

  const setCount = settings.filter(s => s.is_set).length;
  const totalCount = settings.length;

  return (
    <div style={{ fontFamily: "var(--hive-sans)", background: "var(--hive-bg)", minHeight: "100vh", padding: "24px 28px", maxWidth: 720, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "var(--hive-muted)", textDecoration: "none", fontSize: 13 }}>← Dashboard</Link>
          <span style={{ color: "var(--hive-dim)" }}>/</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--hive-text)" }}>Settings</span>
        </div>
        <div style={{ fontFamily: "var(--hive-mono)", fontSize: 11, color: setCount === totalCount ? "var(--hive-green)" : "var(--hive-amber)" }}>
          {setCount}/{totalCount} configured
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", fontSize: 12, padding: 40, textAlign: "center" }}>Loading settings...</div>
      ) : (
        GROUPS.map(group => (
          <div key={group.title} style={{ marginBottom: 32 }}>
            <div style={{
              fontFamily: "var(--hive-mono)", fontSize: 10, fontWeight: 700, color: "var(--hive-muted)",
              letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, paddingBottom: 8,
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
                  padding: "14px 0", borderBottom: "1px solid rgba(255,255,255,0.03)",
                  display: "flex", alignItems: "flex-start", gap: 16
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--hive-text)", marginBottom: 2 }}>
                      {meta.label}
                      {setting?.is_set && (
                        <span style={{
                          marginLeft: 8, fontSize: 9, fontFamily: "var(--hive-mono)", fontWeight: 700,
                          padding: "1px 6px", borderRadius: 3,
                          background: "rgba(60,210,150,0.1)", color: "var(--hive-green)", border: "1px solid rgba(60,210,150,0.2)"
                        }}>SET</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--hive-dim)", marginBottom: 8 }}>{meta.help}</div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type={setting?.is_secret ? "password" : "text"}
                        placeholder={setting?.is_set ? setting.value : meta.placeholder}
                        value={edits[key] ?? ""}
                        onChange={e => setEdits(p => ({ ...p, [key]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") saveSetting(key); }}
                        style={{
                          flex: 1, padding: "7px 10px", fontSize: 13, fontFamily: "var(--hive-mono)",
                          background: "var(--hive-surface)", border: "1px solid var(--hive-border)",
                          borderRadius: 5, color: "var(--hive-text)", outline: "none",
                          transition: "border-color 0.15s",
                        }}
                        onFocus={e => { e.target.style.borderColor = "rgba(232,184,77,0.4)"; }}
                        onBlur={e => { e.target.style.borderColor = "var(--hive-border)"; }}
                      />
                      {isEditing && (
                        <button
                          onClick={() => saveSetting(key)}
                          disabled={isSaving}
                          style={{
                            padding: "7px 14px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700,
                            borderRadius: 5, border: "1px solid rgba(60,210,150,0.4)",
                            background: isSaving ? "rgba(60,210,150,0.05)" : "rgba(60,210,150,0.1)",
                            color: "var(--hive-green)", cursor: isSaving ? "wait" : "pointer",
                            letterSpacing: "0.06em", transition: "all 0.15s"
                          }}
                        >
                          {isSaving ? "..." : "SAVE"}
                        </button>
                      )}
                      {isSaved && (
                        <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: "var(--hive-green)" }}>Saved</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      <div style={{
        marginTop: 20, padding: 16, background: "var(--hive-surface)", borderRadius: 8,
        border: "1px solid var(--hive-border)", fontSize: 12, color: "var(--hive-muted)", lineHeight: 1.7
      }}>
        All secrets are encrypted with AES-256-GCM before storage. The orchestrator decrypts them at runtime using your ENCRYPTION_KEY environment variable. Credential values are never exposed in the dashboard — only the last 4 characters are shown for verification.
      </div>
    </div>
  );
}
