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
type Cycle = {
  id: string; cycle_number: number; status: string; ceo_plan: any; ceo_review: any;
  started_at: string; finished_at: string | null; company_id: string;
};

// === HELPERS ===
const AGENT_MAP: Record<string, { label: string; color: string }> = {
  ceo: { label: "CEO", color: "#f0b944" },
  scout: { label: "Scout", color: "#60a5fa" },
  engineer: { label: "Engineer", color: "#34d399" },
  growth: { label: "Growth", color: "#a78bfa" },
  ops: { label: "Ops", color: "#f472b6" },
  outreach: { label: "Outreach", color: "#fb923c" },
  evolver: { label: "Evolver", color: "#38bdf8" },
};
const STATUS_MAP: Record<string, { label: string; color: string }> = {
  idea: { label: "IDEA", color: "#9d9da8" },
  approved: { label: "APPROVED", color: "#60a5fa" },
  provisioning: { label: "BUILDING", color: "#f0b944" },
  mvp: { label: "MVP", color: "#34d399" },
  active: { label: "ACTIVE", color: "#34d399" },
  paused: { label: "PAUSED", color: "#fb923c" },
  killed: { label: "KILLED", color: "#f87171" },
};
const GATE_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  new_company: { color: "var(--hive-amber)", bg: "var(--hive-amber-bg)", border: "var(--hive-amber-border)" },
  growth_strategy: { color: "var(--hive-purple)", bg: "var(--hive-purple-bg)", border: "var(--hive-purple-border)" },
  spend_approval: { color: "var(--hive-red)", bg: "var(--hive-red-bg)", border: "var(--hive-red-border)" },
  kill_company: { color: "var(--hive-red)", bg: "var(--hive-red-bg)", border: "var(--hive-red-border)" },
  prompt_upgrade: { color: "var(--hive-blue)", bg: "var(--hive-blue-bg)", border: "var(--hive-blue-border)" },
  escalation: { color: "var(--hive-amber)", bg: "var(--hive-amber-bg)", border: "var(--hive-amber-border)" },
};
const DOMAIN_ICONS: Record<string, string> = {
  growth: "📈", engineering: "⚙️", pricing: "💰", ops: "🔧", seo: "🔍", strategy: "🎯",
  marketing: "📣", email: "✉️", onboarding: "🚀", retention: "🔄",
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
function confidenceLabel(c: number): { text: string; color: string; bg: string; border: string } {
  if (c >= 0.85) return { text: "Proven", color: "var(--hive-green)", bg: "var(--hive-green-bg)", border: "var(--hive-green-border)" };
  if (c >= 0.7) return { text: "Strong", color: "var(--hive-blue)", bg: "var(--hive-blue-bg)", border: "var(--hive-blue-border)" };
  if (c >= 0.5) return { text: "Promising", color: "var(--hive-amber)", bg: "var(--hive-amber-bg)", border: "var(--hive-amber-border)" };
  return { text: "Early", color: "var(--hive-text-tertiary)", bg: "rgba(108,108,120,0.08)", border: "rgba(108,108,120,0.18)" };
}
function timeGroup(d: string): string {
  const now = new Date();
  const date = new Date(d);
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0 && now.getDate() === date.getDate()) return "Today";
  if (diffDays <= 1 && now.getDate() - date.getDate() === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  return "Older";
}

// === BADGE COMPONENTS ===
function StatusBadge({ status }: { status: string }) {
  const s = STATUS_MAP[status] || STATUS_MAP.idea;
  return (
    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.06em",
      padding: "2px 8px", borderRadius: 4, color: s.color, background: s.color + "14", border: `1px solid ${s.color}2a` }}>
      {s.label}
    </span>
  );
}

function AgentBadge({ agent }: { agent: string }) {
  const a = AGENT_MAP[agent] || { label: agent.slice(0, 3).toUpperCase(), color: "#9d9da8" };
  return (
    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.06em",
      padding: "2px 7px", borderRadius: 4, color: a.color, background: a.color + "14", border: `1px solid ${a.color}2a` }}>
      {a.label}
    </span>
  );
}

// === TAB BUTTON ===
function TabButton({ label, active, count, onClick }: { label: string; active: boolean; count?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 13, fontFamily: "var(--hive-sans)", fontWeight: active ? 600 : 400,
      padding: "8px 16px", borderRadius: 6, cursor: "pointer", border: "none",
      background: active ? "var(--hive-surface)" : "transparent",
      color: active ? "var(--hive-text)" : "var(--hive-text-secondary)",
      display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s",
    }}>
      {label}
      {count !== undefined && count > 0 && (
        <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
          padding: "1px 6px", borderRadius: 8, minWidth: 18, textAlign: "center",
          background: "var(--hive-amber-bg)", color: "var(--hive-amber)", border: "1px solid var(--hive-amber-border)" }}>
          {count}
        </span>
      )}
    </button>
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
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "inbox" | "activity" | "intelligence">("overview");
  const [activityFilter, setActivityFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdSending, setCmdSending] = useState(false);
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchAll = useCallback(async () => {
    const res = await fetch("/api/dashboard");
    if (!res.ok) return;
    const { data } = await res.json();
    setPortfolio(data.portfolio);
    setCompanies(data.companies);
    setActions(data.actions);
    setApprovals(data.approvals);
    setPlaybook(data.playbook);
    setCycles(data.cycles);
    setLoading(false);
    setLastRefresh(new Date());
  }, []);

  useEffect(() => {
    fetchAll();
    let interval = setInterval(fetchAll, 120_000);
    const onVisibility = () => {
      clearInterval(interval);
      if (document.visibilityState === "visible") {
        fetchAll();
        interval = setInterval(fetchAll, 120_000);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchAll]);

  const handleApproval = async (id: string, decision: "approved" | "rejected") => {
    const res = await fetch(`/api/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (res.ok) fetchAll();
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
      setCmdFeedback(issueUrl ? `Directive created → GitHub #${data.github_issue.number}` : "Directive queued");
      setCmdInput("");
      setTimeout(() => setCmdFeedback(null), 4000);
    }
  };

  // Derived data
  const ideas = approvals.filter(a => a.gate_type === "new_company");
  const otherApprovals = approvals.filter(a => a.gate_type !== "new_company");
  const inboxCount = approvals.length;
  const portfolioCompanies = companies.filter(c => ["mvp", "active", "provisioning", "approved"].includes(c.status));
  const liveCompanies = companies.filter(c => ["active", "mvp"].includes(c.status));

  const filteredActions = activityFilter === "all" ? actions
    : activityFilter === "failed" ? actions.filter(a => a.status === "failed")
    : actions.filter(a => a.company_slug === activityFilter);

  // Get CEO score for a company
  function getCeoScore(companyId: string): number | null {
    const companyCycles = cycles.filter(c => c.company_id === companyId);
    if (companyCycles.length === 0) return null;
    const latest = companyCycles[0];
    try {
      const review = typeof latest.ceo_review === "string" ? JSON.parse(latest.ceo_review) : latest.ceo_review;
      return review?.review?.score || review?.score || null;
    } catch { return null; }
  }
  function getCycleCount(companyId: string): number {
    return cycles.filter(c => c.company_id === companyId).length;
  }

  // Group playbook by domain
  const playbookByDomain = playbook.reduce<Record<string, PlaybookEntry[]>>((acc, p) => {
    const d = p.domain || "general";
    if (!acc[d]) acc[d] = [];
    acc[d].push(p);
    return acc;
  }, {});

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--hive-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontFamily: "var(--hive-mono)", fontSize: 13, color: "var(--hive-text-secondary)" }}>Loading Hive...</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "var(--hive-sans)", background: "var(--hive-bg)", color: "var(--hive-text)", minHeight: "100vh", padding: "24px 28px" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #f0b944, #c49a30)", borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#0c0c0f" }}>H</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--hive-text)", letterSpacing: "-0.02em" }}>Hive</div>
            <div style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>venture orchestrator</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/settings" style={{ fontSize: 13, color: "var(--hive-text-secondary)", fontFamily: "var(--hive-sans)", textDecoration: "none" }}>Settings</Link>
          {lastRefresh && (
            <span onClick={() => fetchAll()} style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", cursor: "pointer" }}
              title="Click to refresh. Auto-refreshes every 2m (pauses when tab hidden).">
              ↻ {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button onClick={() => signOut()} style={{ fontSize: 13, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-sans)",
            background: "none", border: "none", cursor: "pointer" }}>Sign out</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, padding: 4, background: "var(--hive-bg)", borderRadius: 8, border: "1px solid var(--hive-border-subtle)" }}>
        <TabButton label="Overview" active={activeTab === "overview"} onClick={() => setActiveTab("overview")} />
        <TabButton label="Inbox" active={activeTab === "inbox"} count={inboxCount} onClick={() => setActiveTab("inbox")} />
        <TabButton label="Activity" active={activeTab === "activity"} onClick={() => setActiveTab("activity")} />
        <TabButton label="Intelligence" active={activeTab === "intelligence"} onClick={() => setActiveTab("intelligence")} />
      </div>

      {/* ==================== OVERVIEW TAB ==================== */}
      {activeTab === "overview" && (
        <div className="animate-in">
          {/* Command bar */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <input
                  value={cmdInput}
                  onChange={e => setCmdInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDirective(); } }}
                  placeholder='Send a directive — e.g. keyvault: add dark mode toggle'
                  disabled={cmdSending}
                  style={{
                    width: "100%", padding: "10px 14px", fontSize: 13, fontFamily: "var(--hive-mono)",
                    background: "var(--hive-surface)", border: "1px solid var(--hive-border)", borderRadius: 8,
                    color: "var(--hive-text)", outline: "none", transition: "border-color 0.15s",
                  }}
                  onFocus={e => { e.target.style.borderColor = "var(--hive-amber-border)"; }}
                  onBlur={e => { e.target.style.borderColor = "var(--hive-border)"; }}
                />
                {cmdFeedback && (
                  <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                    fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-green)" }}>
                    {cmdFeedback}
                  </div>
                )}
              </div>
              <button onClick={sendDirective} disabled={cmdSending || !cmdInput.trim()} style={{
                padding: "10px 16px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                letterSpacing: "0.04em", borderRadius: 8, cursor: cmdInput.trim() ? "pointer" : "default",
                border: "1px solid var(--hive-amber-border)", background: "var(--hive-amber-bg)",
                color: "var(--hive-amber)", opacity: cmdInput.trim() ? 1 : 0.4, transition: "all 0.15s",
              }}>SEND</button>
            </div>
          </div>

          {/* Metric cards */}
          {portfolio && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
              {[
                { label: "Portfolio MRR", value: fmtCurrency(portfolio.total_mrr) },
                { label: "Total customers", value: String(portfolio.total_customers) },
                { label: "Active companies", value: String(portfolio.live_companies), sub: `${portfolio.total_companies} total` },
                { label: "Last cycle", value: portfolio.last_cycle_at ? timeAgo(portfolio.last_cycle_at) : "—", sub: "Runs on events" },
              ].map((m, i) => (
                <div key={i} style={{ padding: "16px 20px", background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>
                  <div style={{ fontSize: 12, color: "var(--hive-text-secondary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6 }}>{m.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--hive-mono)", color: "var(--hive-text)" }}>{m.value}</div>
                  {m.sub && <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", marginTop: 2 }}>{m.sub}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Scout proposals banner */}
          {ideas.length > 0 && (
            <div onClick={() => setActiveTab("inbox")} style={{
              padding: "12px 16px", marginBottom: 20, borderRadius: 10, cursor: "pointer",
              background: "var(--hive-amber-bg)", border: "1px solid var(--hive-amber-border)",
              display: "flex", alignItems: "center", gap: 8, transition: "background 0.15s",
            }}>
              <span style={{ fontSize: 14 }}>🐝</span>
              <span style={{ fontSize: 13, color: "var(--hive-amber)" }}>
                {ideas.length} new idea{ideas.length > 1 ? "s" : ""} from Scout — {ideas.map(a => a.title).join(", ")} — tap to review
              </span>
            </div>
          )}

          {/* Portfolio */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
              letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Portfolio</div>

            {portfolioCompanies.length === 0 ? (
              <div style={{ padding: 48, textAlign: "center", background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🐝</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--hive-text)", marginBottom: 6 }}>No companies yet</div>
                <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6 }}>
                  Trigger the Scout agent from GitHub Actions to generate business proposals.
                  <br />Go to Actions → &quot;Hive Scout&quot; → Run workflow (mode: ideas)
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {portfolioCompanies.map(c => {
                  const m = c.latest_metrics;
                  const isLive = ["active", "mvp"].includes(c.status);
                  const score = getCeoScore(c.id);
                  const cycleCount = getCycleCount(c.id);
                  const scoreColor = score !== null ? (score >= 7 ? "var(--hive-green)" : score >= 4 ? "var(--hive-amber)" : "var(--hive-red)") : "var(--hive-text-tertiary)";

                  return (
                    <div key={c.id} style={{
                      padding: 20, background: "var(--hive-surface)", borderRadius: 10,
                      border: "1px solid var(--hive-border)", transition: "background 0.15s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--hive-surface-hover)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--hive-surface)"; }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                            <Link href={`/company/${c.slug}`} style={{ fontSize: 15, fontWeight: 600, color: "var(--hive-text)", textDecoration: "none" }}>{c.name}</Link>
                            <StatusBadge status={c.status} />
                          </div>
                          <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.5 }}>{c.description}</div>
                        </div>
                        {score !== null && (
                          <div style={{ textAlign: "center", marginLeft: 16 }}>
                            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "var(--hive-mono)", color: scoreColor }}>{score}</div>
                            <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)" }}>CEO</div>
                          </div>
                        )}
                      </div>

                      {isLive && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
                          <div>
                            <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em" }}>MRR</div>
                            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "var(--hive-mono)", color: (m?.mrr || 0) > 0 ? "var(--hive-green)" : "var(--hive-text-tertiary)" }}>{fmtCurrency(m?.mrr || 0)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em" }}>Customers</div>
                            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "var(--hive-mono)" }}>{m?.customers || 0}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em" }}>Views</div>
                            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "var(--hive-mono)" }}>{m?.page_views || 0}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em" }}>Cycles</div>
                            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "var(--hive-mono)" }}>{cycleCount}</div>
                          </div>
                        </div>
                      )}

                      {c.status === "provisioning" && (
                        <div style={{ fontSize: 12, color: "var(--hive-amber)", marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--hive-amber)", animation: "pulse 1.5s ease infinite" }} />
                          Infrastructure being created...
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hive-border-subtle)" }}>
                        <div style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                          {c.vercel_url || "no deployment yet"}
                        </div>
                        {(c.pending_approvals || 0) > 0 && (
                          <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                            padding: "2px 8px", borderRadius: 8,
                            background: "var(--hive-amber-bg)", color: "var(--hive-amber)", border: "1px solid var(--hive-amber-border)" }}>
                            {c.pending_approvals} pending
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent activity preview */}
          {actions.length > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                  letterSpacing: "0.06em", textTransform: "uppercase" }}>Recent activity</div>
                <button onClick={() => setActiveTab("activity")} style={{
                  fontSize: 12, color: "var(--hive-text-secondary)", background: "none", border: "none", cursor: "pointer",
                  fontFamily: "var(--hive-sans)",
                }}>View all →</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {actions.slice(0, 4).map(a => {
                  const isFail = a.status === "failed";
                  return (
                    <div key={a.id} style={{
                      display: "flex", gap: 12, padding: "10px 14px", borderRadius: 8,
                      background: isFail ? "var(--hive-red-bg)" : "transparent",
                    }}>
                      <div style={{ minWidth: 70 }}><AgentBadge agent={a.agent} /></div>
                      <div style={{ flex: 1, fontSize: 13, color: isFail ? "var(--hive-red)" : "var(--hive-text-secondary)", lineHeight: 1.5 }}>
                        {a.description}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", minWidth: 60, textAlign: "right" }}>
                        {a.finished_at ? timeAgo(a.finished_at) : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== INBOX TAB ==================== */}
      {activeTab === "inbox" && (
        <div className="animate-in">
          {approvals.length === 0 ? (
            <div style={{ padding: 64, textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              <div style={{ fontSize: 15, fontWeight: 500, color: "var(--hive-text)", marginBottom: 6 }}>Inbox clear</div>
              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)" }}>Agents are running autonomously</div>
            </div>
          ) : (
            <>
              {/* Scout proposals */}
              {ideas.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                    letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Scout proposals</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {ideas.map(a => {
                      const proposal = a.context?.proposal || {};
                      const confidence = proposal.confidence || 0;
                      const isPortuguese = proposal.market === "pt" || a.description?.toLowerCase().includes("portug");
                      return (
                        <div key={a.id} style={{
                          padding: 20, borderRadius: 10,
                          background: "var(--hive-amber-bg)", border: "1px solid var(--hive-amber-border)",
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--hive-text)" }}>{a.title}</span>
                                {confidence > 0 && (
                                  <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                                    padding: "2px 8px", borderRadius: 4,
                                    background: "var(--hive-amber-bg)", color: "var(--hive-amber)", border: "1px solid var(--hive-amber-border)" }}>
                                    {Math.round(confidence * 100)}%
                                  </span>
                                )}
                                <span style={{ fontSize: 12 }}>{isPortuguese ? "🇵🇹" : "🌍"}</span>
                              </div>
                              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6 }}>{a.description}</div>
                            </div>
                          </div>
                          {(proposal.tam || proposal.monetisation) && (
                            <div style={{ display: "flex", gap: 24, marginBottom: 14, fontSize: 12, color: "var(--hive-text-tertiary)" }}>
                              {proposal.tam && <span><strong style={{ color: "var(--hive-text-secondary)" }}>TAM:</strong> {proposal.tam}</span>}
                              {proposal.monetisation && <span><strong style={{ color: "var(--hive-text-secondary)" }}>Model:</strong> {proposal.monetisation}</span>}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => handleApproval(a.id, "approved")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-green-border)", background: "var(--hive-green-bg)", color: "var(--hive-green)",
                            }}>Approve</button>
                            <button onClick={() => handleApproval(a.id, "rejected")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-text-tertiary)",
                            }}>Pass</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Other approvals */}
              {otherApprovals.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                    letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Pending approvals</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {otherApprovals.map(a => {
                      const gc = GATE_COLORS[a.gate_type] || { color: "var(--hive-text-secondary)", bg: "var(--hive-surface)", border: "var(--hive-border)" };
                      return (
                        <div key={a.id} style={{ padding: 20, borderRadius: 10, background: gc.bg, border: `1px solid ${gc.border}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              padding: "2px 8px", borderRadius: 4, color: gc.color, background: gc.bg, border: `1px solid ${gc.border}` }}>
                              {a.gate_type.replace(/_/g, " ")}
                            </span>
                            {a.company_slug && (
                              <Link href={`/company/${a.company_slug}`} style={{ fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-text-tertiary)", textDecoration: "none" }}>
                                {a.company_name || a.company_slug}
                              </Link>
                            )}
                            <span style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", marginLeft: "auto" }}>{timeAgo(a.created_at)}</span>
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--hive-text)", marginBottom: 4 }}>{a.title}</div>
                          <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>{a.description}</div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => handleApproval(a.id, "approved")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-green-border)", background: "var(--hive-green-bg)", color: "var(--hive-green)",
                            }}>Approve</button>
                            <button onClick={() => handleApproval(a.id, "rejected")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-red-border)", background: "var(--hive-red-bg)", color: "var(--hive-red)",
                            }}>Reject</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ==================== ACTIVITY TAB ==================== */}
      {activeTab === "activity" && (
        <div className="animate-in">
          {/* Filters */}
          <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
            {[{ key: "all", label: "All" }, { key: "failed", label: "Failures" },
              ...liveCompanies.map(c => ({ key: c.slug, label: c.name }))
            ].map(t => (
              <button key={t.key} onClick={() => setActivityFilter(t.key)} style={{
                fontSize: 12, fontFamily: "var(--hive-sans)", padding: "5px 12px", borderRadius: 6, cursor: "pointer",
                border: `1px solid ${activityFilter === t.key ? "var(--hive-amber-border)" : "var(--hive-border)"}`,
                background: activityFilter === t.key ? "var(--hive-amber-bg)" : "transparent",
                color: activityFilter === t.key ? "var(--hive-amber)" : "var(--hive-text-secondary)",
              }}>{t.label}</button>
            ))}
          </div>

          {filteredActions.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--hive-text-secondary)", fontSize: 13 }}>
              No agent activity yet. Run the orchestrator or trigger an agent from GitHub Actions.
            </div>
          ) : (
            <div>
              {/* Group by time */}
              {(() => {
                const groups: Record<string, Action[]> = {};
                filteredActions.forEach(a => {
                  const g = a.finished_at ? timeGroup(a.finished_at) : "Older";
                  if (!groups[g]) groups[g] = [];
                  groups[g].push(a);
                });
                return Object.entries(groups).map(([group, acts]) => (
                  <div key={group} style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-dim)",
                      letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--hive-border-subtle)" }}>
                      {group}
                    </div>
                    {acts.map(a => {
                      const isFail = a.status === "failed";
                      return (
                        <div key={a.id} style={{
                          display: "flex", gap: 12, padding: "10px 14px", borderRadius: 8,
                          background: isFail ? "var(--hive-red-bg)" : "transparent",
                          marginBottom: 2,
                        }}>
                          <div style={{ minWidth: 80 }}><AgentBadge agent={a.agent} /></div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, color: isFail ? "var(--hive-red)" : "var(--hive-text-secondary)", lineHeight: 1.5 }}>
                              {a.description}
                            </div>
                            {isFail && a.error && (
                              <div style={{ fontSize: 12, color: "var(--hive-red)", marginTop: 4, fontFamily: "var(--hive-mono)", opacity: 0.8 }}>{a.error}</div>
                            )}
                            {isFail && a.reflection && (
                              <div style={{ fontSize: 12, color: "var(--hive-purple)", marginTop: 4, padding: "6px 10px",
                                background: "var(--hive-purple-bg)", borderRadius: 4, borderLeft: "2px solid var(--hive-purple-border)" }}>
                                {a.reflection}
                              </div>
                            )}
                          </div>
                          <div style={{ minWidth: 80, textAlign: "right" }}>
                            <div style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                              {a.company_slug ? <Link href={`/company/${a.company_slug}`} style={{ color: "var(--hive-text-dim)", textDecoration: "none" }}>{a.company_slug}</Link> : "—"}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                              {a.finished_at ? timeAgo(a.finished_at) : ""}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
          )}
        </div>
      )}

      {/* ==================== INTELLIGENCE TAB ==================== */}
      {activeTab === "intelligence" && (
        <div className="animate-in">
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--hive-text)", marginBottom: 4 }}>What&apos;s working</div>
            <div style={{ fontSize: 13, color: "var(--hive-text-secondary)" }}>Intelligence extracted across all companies. Agents reference these when making decisions.</div>
          </div>

          {playbook.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--hive-text-secondary)", fontSize: 13 }}>
              No playbook entries yet. Insights will appear here as companies run cycles.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {Object.entries(playbookByDomain).map(([domain, entries]) => (
                <div key={domain}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 14 }}>{DOMAIN_ICONS[domain] || "📋"}</span>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--hive-text)", textTransform: "capitalize" }}>{domain}</div>
                    <span style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>{entries.length}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {entries.map(p => {
                      const cl = confidenceLabel(p.confidence);
                      return (
                        <div key={p.id} style={{ padding: "14px 18px", background: "var(--hive-surface)", borderRadius: 10,
                          border: "1px solid var(--hive-border)" }}>
                          <div style={{ fontSize: 13, color: "var(--hive-text)", lineHeight: 1.6, marginBottom: 8 }}>{p.insight}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              padding: "2px 8px", borderRadius: 4, color: cl.color, background: cl.bg, border: `1px solid ${cl.border}` }}>
                              {cl.text}
                            </span>
                            {p.source_company && (
                              <span style={{ fontSize: 12, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)" }}>from {p.source_company}</span>
                            )}
                            <span style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>used {p.applied_count}×</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 40, paddingTop: 16, borderTop: "1px solid var(--hive-border-subtle)",
        display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
        <span>hive v0.2.0 · event-driven</span>
        <span>neon · vercel · claude max 5x · github actions</span>
      </div>
    </div>
  );
}
