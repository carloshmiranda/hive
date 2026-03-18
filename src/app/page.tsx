"use client";
import { useState, useEffect, useCallback } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";

// === TYPES ===
type Company = {
  id: string; name: string; slug: string; description: string; status: string;
  vercel_url: string | null; created_at: string; killed_at: string | null; kill_reason: string | null;
  latest_metrics: any; pending_approvals: number;
};
type Action = {
  id: string; company_id: string; company_slug: string; agent: string; action_type: string;
  description: string; status: string; error: string | null; reflection: string | null;
  tokens_used: number; finished_at: string;
};
type Approval = {
  id: string; company_id: string | null; company_name: string | null; company_slug: string | null;
  gate_type: string; title: string; description: string; context: any;
  status: string; created_at: string;
};
type PlaybookEntry = { id: string; domain: string; insight: string; confidence: number; applied_count: number; source_company: string | null };
type Portfolio = {
  live_companies: number; total_companies: number; total_mrr: number;
  total_revenue: number; total_customers: number; pending_approvals: number;
  tokens_today: number; last_cycle_at: string | null;
};

// === HELPERS ===
const AGENT_MAP: Record<string, { label: string; color: string }> = {
  ceo: { label: "CEO", color: "#e8b84d" }, engineer: { label: "ENG", color: "#5ba8e8" },
  growth: { label: "GRO", color: "#6dd490" }, ops: { label: "OPS", color: "#a88cdb" },
  provisioner: { label: "PRV", color: "#d4a057" }, auto_healer: { label: "HEAL", color: "#e87070" },
  idea_scout: { label: "IDE", color: "#70c4e8" }, kill_switch: { label: "KILL", color: "#e85050" },
  retro_analyst: { label: "RET", color: "#b090d0" }, prompt_evolver: { label: "EVO", color: "#d0b060" },
  health_monitor: { label: "MON", color: "#e8a050" }, venture_brain: { label: "VB", color: "#f0c040" },
};
const STATUS_MAP: Record<string, { label: string; color: string }> = {
  idea: { label: "IDEA", color: "rgb(148,130,100)" }, approved: { label: "APPROVED", color: "rgb(100,160,200)" },
  provisioning: { label: "BUILDING", color: "rgb(200,170,80)" }, mvp: { label: "MVP", color: "rgb(120,180,140)" },
  active: { label: "ACTIVE", color: "rgb(60,210,150)" }, paused: { label: "PAUSED", color: "rgb(180,140,100)" },
  killed: { label: "KILLED", color: "rgb(200,90,80)" },
};
const GATE_ICONS: Record<string, { icon: string; color: string }> = {
  new_company: { icon: "◆", color: "#e8b84d" }, spend_approval: { icon: "€", color: "#e87070" },
  growth_strategy: { icon: "↗", color: "#6dd490" }, kill_company: { icon: "✕", color: "#e85050" },
  prompt_upgrade: { icon: "↻", color: "#b090d0" }, escalation: { icon: "!", color: "#e8a050" },
};

function fmtCurrency(n: number) { return "€" + n.toLocaleString("en", { minimumFractionDigits: 0 }); }
function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

// === BADGE COMPONENTS ===
function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status] || STATUS_MAP.idea;
  return (
    <span style={{ fontSize: 10, fontFamily: "var(--hive-mono)", fontWeight: 600, letterSpacing: "0.08em",
      padding: "2px 8px", borderRadius: 3, color: s.color, background: s.color + "1a", border: `1px solid ${s.color}33` }}>
      {s.label}
    </span>
  );
}

function AgentBadge({ agent }: { agent: string }) {
  const a = AGENT_MAP[agent] || { label: agent.slice(0, 3).toUpperCase(), color: "#888" };
  return (
    <span style={{ fontSize: 9, fontFamily: "var(--hive-mono)", fontWeight: 700, letterSpacing: "0.1em",
      padding: "2px 6px", borderRadius: 3, color: a.color, background: a.color + "18", border: `1px solid ${a.color}33` }}>
      {a.label}
    </span>
  );
}

// === MAIN DASHBOARD ===
export default function DashboardPage() {
  const { data: session } = useSession();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [playbook, setPlaybook] = useState<PlaybookEntry[]>([]);
  const [activityFilter, setActivityFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdSending, setCmdSending] = useState(false);
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importName, setImportName] = useState("");
  const [importSlug, setImportSlug] = useState("");

  const fetchAll = useCallback(async () => {
    const [pRes, cRes, aRes, apRes, plRes] = await Promise.all([
      fetch("/api/portfolio"), fetch("/api/companies"),
      fetch("/api/actions?limit=30"), fetch("/api/approvals?status=pending"),
      fetch("/api/playbook"),
    ]);
    if (pRes.ok) setPortfolio((await pRes.json()).data);
    if (cRes.ok) setCompanies((await cRes.json()).data);
    if (aRes.ok) setActions((await aRes.json()).data);
    if (apRes.ok) setApprovals((await apRes.json()).data);
    if (plRes.ok) setPlaybook((await plRes.json()).data);
    setLoading(false);
    setLastRefresh(new Date());
  }, []);

  useEffect(() => {
    fetchAll();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleApproval = async (id: string, decision: "approved" | "rejected") => {
    const res = await fetch(`/api/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (res.ok) fetchAll(); // Refresh everything
  };

  const sendDirective = async () => {
    if (!cmdInput.trim()) return;
    setCmdSending(true);
    const res = await fetch("/api/directives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cmdInput }),
    });
    setCmdSending(false);
    if (res.ok) {
      const { data } = await res.json();
      const issueUrl = data.github_issue?.url;
      setCmdFeedback(issueUrl ? `Directive created → GitHub #${data.github_issue.number}` : "Directive queued for next cycle");
      setCmdInput("");
      setTimeout(() => setCmdFeedback(null), 4000);
    }
  };

  const handleImport = async () => {
    if (!importName || !importSlug) return;
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
    if (res.ok) {
      setShowImport(false);
      setImportUrl(""); setImportName(""); setImportSlug("");
      fetchAll();
    }
  };

  const filteredActions = activityFilter === "all" ? actions
    : activityFilter === "failed" ? actions.filter(a => a.status === "failed")
    : actions.filter(a => a.company_slug === activityFilter);

  const liveCompanies = companies.filter(c => ["active", "mvp"].includes(c.status));

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--hive-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: "var(--hive-mono)", fontSize: 12, color: "var(--hive-muted)" }}>Loading Hive...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--hive-sans)", background: "var(--hive-bg)", color: "var(--hive-text)", minHeight: "100vh", padding: "24px 28px" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #e8b84d, #d4a040)", borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#08080d" }}>H</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#f0f0f4", letterSpacing: "-0.02em" }}>Hive</div>
            <div style={{ fontSize: 11, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)" }}>venture orchestrator</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {(portfolio?.pending_approvals || 0) > 0 && (
            <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", padding: "4px 10px", borderRadius: 4,
              background: "rgba(232,184,77,0.12)", color: "var(--hive-amber)", border: "1px solid rgba(232,184,77,0.2)" }}>
              {portfolio?.pending_approvals} pending
            </div>
          )}
          <Link href="/settings" style={{ fontSize: 11, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", textDecoration: "none" }}>Settings</Link>
          {lastRefresh && (
            <span onClick={() => fetchAll()} style={{ fontSize: 10, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)", cursor: "pointer", opacity: 0.6 }}
              title="Click to refresh now. Auto-refreshes every 30s.">
              ↻ {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button onClick={() => signOut()} style={{ fontSize: 11, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)",
            background: "none", border: "none", cursor: "pointer" }}>Sign out</button>
        </div>
      </div>

      {/* Command bar */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <input
              value={cmdInput}
              onChange={e => setCmdInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDirective(); } }}
              placeholder='Directive → "pawly: add free trial" or "@engineer fix mobile layout"'
              disabled={cmdSending}
              style={{
                width: "100%", padding: "10px 14px", fontSize: 13, fontFamily: "var(--hive-mono)",
                background: "var(--hive-surface)", border: "1px solid var(--hive-border)", borderRadius: 6,
                color: "var(--hive-text)", outline: "none", transition: "border-color 0.15s",
              }}
              onFocus={e => { e.target.style.borderColor = "rgba(232,184,77,0.4)"; }}
              onBlur={e => { e.target.style.borderColor = "var(--hive-border)"; }}
            />
            {cmdFeedback && (
              <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontSize: 11, fontFamily: "var(--hive-mono)", color: "var(--hive-green)" }}>
                {cmdFeedback}
              </div>
            )}
          </div>
          <button onClick={sendDirective} disabled={cmdSending || !cmdInput.trim()} style={{
            padding: "10px 16px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700,
            letterSpacing: "0.06em", borderRadius: 6, cursor: cmdInput.trim() ? "pointer" : "default",
            border: "1px solid rgba(232,184,77,0.3)", background: "rgba(232,184,77,0.08)",
            color: "var(--hive-amber)", opacity: cmdInput.trim() ? 1 : 0.4, transition: "all 0.15s",
          }}>SEND</button>
          <button onClick={() => setShowImport(!showImport)} style={{
            padding: "10px 16px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700,
            letterSpacing: "0.06em", borderRadius: 6, cursor: "pointer",
            border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)",
            color: "var(--hive-muted)", transition: "all 0.15s",
          }}>IMPORT</button>
        </div>

        {/* Import dialog */}
        {showImport && (
          <div style={{ marginTop: 10, padding: 16, background: "var(--hive-surface)", borderRadius: 8,
            border: "1px solid var(--hive-border)" }} className="animate-in">
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--hive-text)", marginBottom: 12 }}>
              Import existing project into Hive
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <input value={importName} onChange={e => {
                setImportName(e.target.value);
                if (!importSlug || importSlug === importName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) {
                  setImportSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                }
              }} placeholder="Company name (e.g. Flolio)" style={{
                padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                border: "1px solid var(--hive-border)", borderRadius: 5, color: "var(--hive-text)", outline: "none",
              }} />
              <input value={importSlug} onChange={e => setImportSlug(e.target.value)} placeholder="slug (e.g. flolio)" style={{
                padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                border: "1px solid var(--hive-border)", borderRadius: 5, color: "var(--hive-text)", outline: "none",
              }} />
            </div>
            <input value={importUrl} onChange={e => setImportUrl(e.target.value)}
              placeholder="GitHub URL (e.g. https://github.com/carlos-miranda/flolio) — optional for manual imports"
              style={{
                width: "100%", padding: "8px 12px", fontSize: 13, fontFamily: "var(--hive-mono)", background: "var(--hive-bg)",
                border: "1px solid var(--hive-border)", borderRadius: 5, color: "var(--hive-text)", outline: "none", marginBottom: 12,
              }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowImport(false)} style={{
                padding: "7px 14px", fontSize: 11, fontFamily: "var(--hive-mono)", borderRadius: 5,
                border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-muted)", cursor: "pointer",
              }}>Cancel</button>
              <button onClick={handleImport} disabled={!importName || !importSlug} style={{
                padding: "7px 14px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700, borderRadius: 5,
                border: "1px solid rgba(91,168,232,0.4)", background: "rgba(91,168,232,0.1)",
                color: "var(--hive-blue)", cursor: importName && importSlug ? "pointer" : "default",
                opacity: importName && importSlug ? 1 : 0.4,
              }}>Scan &amp; Import</button>
            </div>
            <div style={{ fontSize: 11, color: "var(--hive-dim)", marginTop: 10, lineHeight: 1.6 }}>
              For GitHub repos: Hive scans the codebase, detects tech stack, checks for CLAUDE.md and env files, then creates an approval gate with an onboarding plan. Existing code is never overwritten.
            </div>
          </div>
        )}
      </div>

      {/* Top metrics */}
      {portfolio && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 28 }}>
          {[
            { label: "Portfolio MRR", value: fmtCurrency(portfolio.total_mrr) },
            { label: "Total revenue", value: fmtCurrency(portfolio.total_revenue) },
            { label: "Customers", value: String(portfolio.total_customers) },
            { label: "Companies", value: `${portfolio.live_companies} live / ${portfolio.total_companies} total` },
            { label: "Tokens today", value: portfolio.tokens_today.toLocaleString(), sub: "~$0 (Max 5x)" },
          ].map((m, i) => (
            <div key={i} style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ fontSize: 10, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>{m.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--hive-mono)", color: "#f0f0f4" }}>{m.value}</div>
              {m.sub && <div style={{ fontSize: 11, color: "var(--hive-muted)", marginTop: 2 }}>{m.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Main grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Left: Companies + Playbook */}
        <div>
          <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700, color: "var(--hive-muted)",
            letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>Portfolio</div>

          {companies.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--hive-dim)", fontSize: 13, border: "1px dashed var(--hive-border)", borderRadius: 8 }}>
              No companies yet. The orchestrator will create them when you approve ideas.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {companies.map(c => {
                const isDead = c.status === "killed";
                const m = c.latest_metrics;
                const isLive = ["active", "mvp"].includes(c.status);
                return (
                  <div key={c.id} style={{ padding: 16, background: isDead ? "rgba(200,90,80,0.04)" : "rgba(255,255,255,0.02)",
                    borderRadius: 8, border: `1px solid ${isDead ? "rgba(200,90,80,0.15)" : "rgba(255,255,255,0.06)"}`,
                    opacity: isDead ? 0.6 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f4", marginBottom: 4 }}>
                          <Link href={`/company/${c.slug}`} style={{ color: "#f0f0f4", textDecoration: "none" }}>{c.name}</Link>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--hive-muted)" }}>{c.description}</div>
                      </div>
                      <StatusBadge status={c.status} />
                    </div>
                    {isLive && m && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
                        <div>
                          <div style={{ fontSize: 9, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", letterSpacing: "0.06em" }}>MRR</div>
                          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--hive-mono)", color: m.mrr > 0 ? "var(--hive-green)" : "var(--hive-muted)" }}>{fmtCurrency(m.mrr)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", letterSpacing: "0.06em" }}>USERS</div>
                          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--hive-mono)" }}>{m.customers}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)", letterSpacing: "0.06em" }}>VIEWS</div>
                          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--hive-mono)" }}>{m.page_views}</div>
                        </div>
                      </div>
                    )}
                    {isDead && c.kill_reason && (
                      <div style={{ fontSize: 11, color: "rgb(200,90,80)", marginTop: 8, fontStyle: "italic" }}>{c.kill_reason}</div>
                    )}
                    {c.status === "provisioning" && (
                      <div style={{ fontSize: 11, color: "var(--hive-amber)", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--hive-amber)", animation: "pulse 1.5s ease infinite" }} />
                        Infrastructure being created...
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: "var(--hive-dim)", marginTop: 10, fontFamily: "var(--hive-mono)" }}>
                      {c.vercel_url || "no deployment yet"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Playbook */}
          {playbook.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700, color: "var(--hive-muted)",
                letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
                Playbook ({playbook.length} learnings)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {playbook.slice(0, 8).map(p => (
                  <div key={p.id} style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "var(--hive-text)" }}>{p.insight}</div>
                      <div style={{ fontSize: 10, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)", marginTop: 2 }}>
                        {p.domain} · {p.source_company ? `from ${p.source_company}` : "global"} · used {p.applied_count}x
                      </div>
                    </div>
                    <div style={{ minWidth: 50, textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--hive-mono)",
                        color: p.confidence > 0.7 ? "var(--hive-green)" : "var(--hive-amber)" }}>
                        {Math.round(p.confidence * 100)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Approvals + Activity */}
        <div>
          {/* Approvals */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700, color: "var(--hive-amber)",
              letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
              Awaiting your decision ({approvals.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {approvals.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--hive-dim)", fontSize: 12, fontFamily: "var(--hive-mono)" }}>
                  All clear — no pending decisions
                </div>
              ) : approvals.map(a => {
                const gate = GATE_ICONS[a.gate_type] || { icon: "?", color: "#888" };
                return (
                  <div key={a.id} style={{ padding: 16, background: "rgba(232,184,77,0.03)", borderRadius: 8, border: "1px solid rgba(232,184,77,0.12)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 16, color: gate.color, fontWeight: 700, width: 24, textAlign: "center" }}>{gate.icon}</span>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#f0f0f4" }}>{a.title}</div>
                        <div style={{ fontSize: 10, color: "var(--hive-muted)", fontFamily: "var(--hive-mono)" }}>
                          {a.company_slug ? <Link href={`/company/${a.company_slug}`} style={{ color: "var(--hive-muted)", textDecoration: "none" }}>{a.company_slug}</Link> : "portfolio"} · {timeAgo(a.created_at)}
                        </div>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "#9090a0", lineHeight: 1.6, marginBottom: 12 }}>{a.description}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => handleApproval(a.id, "approved")} style={{
                        padding: "6px 16px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700,
                        letterSpacing: "0.06em", borderRadius: 4, cursor: "pointer",
                        border: "1px solid rgba(60,210,150,0.4)", background: "rgba(60,210,150,0.1)", color: "var(--hive-green)"
                      }}>APPROVE</button>
                      <button onClick={() => handleApproval(a.id, "rejected")} style={{
                        padding: "6px 16px", fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700,
                        letterSpacing: "0.06em", borderRadius: 4, cursor: "pointer",
                        border: "1px solid rgba(200,90,80,0.3)", background: "rgba(200,90,80,0.06)", color: "var(--hive-red)"
                      }}>REJECT</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Activity feed */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 700, color: "var(--hive-muted)",
                letterSpacing: "0.1em", textTransform: "uppercase" }}>Agent activity</div>
              <div style={{ display: "flex", gap: 4 }}>
                {[{ key: "all", label: "All" }, { key: "failed", label: "Failures" },
                  ...liveCompanies.map(c => ({ key: c.slug, label: c.slug }))
                ].map(t => (
                  <button key={t.key} onClick={() => setActivityFilter(t.key)} style={{
                    fontSize: 10, fontFamily: "var(--hive-mono)", padding: "3px 8px", borderRadius: 3, cursor: "pointer",
                    border: `1px solid ${activityFilter === t.key ? "rgba(232,184,77,0.3)" : "rgba(255,255,255,0.06)"}`,
                    background: activityFilter === t.key ? "rgba(232,184,77,0.1)" : "transparent",
                    color: activityFilter === t.key ? "var(--hive-amber)" : "var(--hive-muted)",
                  }}>{t.label}</button>
                ))}
              </div>
            </div>

            {filteredActions.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--hive-dim)", fontSize: 12, fontFamily: "var(--hive-mono)" }}>
                No agent activity yet. Run the orchestrator to see results here.
              </div>
            ) : (
              <div style={{ maxHeight: 600, overflowY: "auto" }}>
                {filteredActions.map(a => {
                  const isFail = a.status === "failed";
                  return (
                    <div key={a.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <div style={{ minWidth: 44, textAlign: "right" }}><AgentBadge agent={a.agent} /></div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: isFail ? "var(--hive-red)" : "#d0d0d8", lineHeight: 1.5 }}>
                          {a.description}
                        </div>
                        {isFail && a.reflection && (
                          <div style={{ fontSize: 11, color: "var(--hive-purple)", marginTop: 4, padding: "6px 10px",
                            background: "rgba(176,144,208,0.06)", borderRadius: 4, borderLeft: "2px solid rgba(176,144,208,0.3)" }}>
                            Reflection: {a.reflection}
                          </div>
                        )}
                        {isFail && a.error && (
                          <div style={{ fontSize: 11, color: "var(--hive-red)", marginTop: 4, fontFamily: "var(--hive-mono)" }}>{a.error}</div>
                        )}
                      </div>
                      <div style={{ minWidth: 80, textAlign: "right" }}>
                        <div style={{ fontSize: 10, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)" }}>
                          {a.company_slug ? <Link href={`/company/${a.company_slug}`} style={{ color: "var(--hive-dim)", textDecoration: "none" }}>{a.company_slug}</Link> : "—"}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)" }}>{a.tokens_used?.toLocaleString()}t</div>
                        <div style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", marginTop: 4,
                          background: isFail ? "var(--hive-red)" : a.status === "success" ? "var(--hive-green)" : "var(--hive-amber)" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.04)",
        display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--hive-dim)", fontFamily: "var(--hive-mono)" }}>
        <span>hive v0.1.0 · orchestrator layer</span>
        <span>neon · vercel · claude max 5x · resend</span>
      </div>
    </div>
  );
}
