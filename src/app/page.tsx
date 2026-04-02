"use client";
import { useState, useEffect, useCallback } from "react";
import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { AGENT_DISPLAY } from "@/lib/agent-display";

// === TYPES ===
type Company = {
  id: string; name: string; slug: string; description: string; status: string;
  vercel_url: string | null; created_at: string; killed_at: string | null; kill_reason: string | null;
  latest_metrics: any; pending_approvals: number;
  pending_approval_details: Array<{ gate_type: string; title: string }>;
  tasks_done: number; tasks_total: number;
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
  total_revenue: number; total_customers: number; total_waitlist: number;
  pending_approvals: number;
  tokens_today: number; last_cycle_at: string | null;
};
type Todo = {
  id: string;
  severity: "blocker" | "warning" | "info";
  category: "setup" | "manual_action" | "health" | "agent";
  title: string;
  detail: string;
  action_url: string | null;
  action_label: string | null;
  company_slug: string | null;
  dismissable: boolean;
};
type Cycle = {
  id: string; cycle_number: number; status: string; ceo_plan: any; ceo_review: any;
  started_at: string; finished_at: string | null; company_id: string;
};
type EvolverProposal = {
  id: string; gap_type: string; severity: string; title: string; diagnosis: string;
  signal_source: string; signal_data: any; proposed_fix: any;
  affected_companies: string[]; cross_company: boolean; status: string;
  playbook_entry_id: string | null; created_at: string; notes: string | null;
};
type NeonProject = { id: string; name: string; storage_gb: number; storage_pct: number; compute_hours: number; compute_pct: number };
type NeonUsage = { projects: NeonProject[]; totals: { storage_gb: number; compute_hours: number }; limits: { storage_gb_per_project: number; compute_hours_per_month: number }; error?: string };

// === HELPERS ===
const AGENT_COLOR: Record<string, string> = {
  ceo: "#f0b944", scout: "#60a5fa", engineer: "#34d399",
  growth: "#a78bfa", ops: "#f472b6", outreach: "#fb923c",
  evolver: "#38bdf8", sentinel: "#e879f9", healer: "#4ade80", backlog: "#94a3b8",
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
  const display = AGENT_DISPLAY[agent] || { name: agent, icon: "🤖" };
  const color = AGENT_COLOR[agent] || "#9d9da8";
  return (
    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.06em",
      padding: "2px 7px", borderRadius: 4, color, background: color + "14", border: `1px solid ${color}2a` }}>
      {display.icon} {display.name}
    </span>
  );
}

// === TAB BUTTON ===
function TabButton({ label, active, count, onClick }: { label: string; active: boolean; count?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 13, fontFamily: "var(--hive-sans)", fontWeight: active ? 600 : 400,
      padding: "8px 16px", paddingBottom: 10, borderRadius: 0, cursor: "pointer",
      background: "transparent",
      borderTop: "none", borderLeft: "none", borderRight: "none",
      borderBottom: active ? "2px solid var(--hive-amber)" : "2px solid transparent",
      marginBottom: "-1px",
      color: active ? "var(--hive-text)" : "var(--hive-text-secondary)",
      display: "flex", alignItems: "center", gap: 6, transition: "color 0.15s, border-color 0.15s",
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
  const [evolverProposals, setEvolverProposals] = useState<EvolverProposal[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "inbox" | "activity" | "intelligence">("overview");
  const [activityFilter, setActivityFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdSending, setCmdSending] = useState(false);
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [showAllTodos, setShowAllTodos] = useState(false);
  const [selectedApprovals, setSelectedApprovals] = useState<Set<string>>(new Set());
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [neonUsage, setNeonUsage] = useState<NeonUsage | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      const { data } = await res.json();
      setPortfolio(data.portfolio);
      setCompanies(data.companies);
      setActions(data.actions);
      setApprovals(data.approvals);
      setPlaybook(data.playbook);
      setCycles(data.cycles);
      setEvolverProposals(data.evolverProposals || []);
      setLoadError(false);
      setLoading(false);
      setLastRefresh(new Date());

      // Fetch todos separately (not in consolidated endpoint)
      try {
        const todoRes = await fetch("/api/todos");
        if (todoRes.ok) setTodos((await todoRes.json()).data || []);
      } catch { /* non-critical */ }
    } catch {
      setLoadError(true);
      setLoading(false);
    }
  }, []);

  // Neon usage: fetched once on load (calls external Neon API — no need to poll every 2m)
  useEffect(() => {
    fetch("/api/infra/neon-usage")
      .then(r => r.json())
      .then(d => d?.data && setNeonUsage(d.data))
      .catch(() => {});
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
    let note: string | undefined;
    if (decision === "rejected") {
      const input = prompt("Rejection reason (helps Scout avoid similar ideas):");
      if (input === null) return; // user cancelled
      note = input || undefined;
    }
    const res = await fetch(`/api/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, note }),
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

  const dismissTodo = async (todoId: string) => {
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todo_id: todoId }),
    });
    setTodos(prev => prev.filter(t => t.id !== todoId));
  };

  const handleProposalDecision = async (id: string, decision: "approved" | "rejected" | "deferred") => {
    const res = await fetch("/api/evolver", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    if (res.ok) fetchAll();
  };

  const toggleApprovalSelection = (id: string) => {
    setSelectedApprovals(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allIds = approvals.map(a => a.id);
    setSelectedApprovals(prev => {
      if (prev.size === allIds.length) return new Set();
      return new Set(allIds);
    });
  };

  const handleBatchReject = async () => {
    if (selectedApprovals.size === 0) return;
    const input = prompt(`Reject ${selectedApprovals.size} selected approval(s)? Enter rejection reason:`);
    if (input === null) return;
    setBatchProcessing(true);
    try {
      const res = await fetch("/api/approvals/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedApprovals), decision: "rejected", note: input || undefined }),
      });
      if (res.ok) {
        setSelectedApprovals(new Set());
        fetchAll();
      }
    } finally {
      setBatchProcessing(false);
    }
  };

  // Derived data
  const blockerCount = todos.filter(t => t.severity === "blocker").length;
  // Scout proposals include new_company AND growth_strategy with Scout/CEO context (expansion/question types)
  const isScoutProposal = (a: any) => {
    if (a.gate_type === "new_company") return true;
    if (a.gate_type === "growth_strategy") {
      try {
        const ctx = typeof a.context === "string" ? JSON.parse(a.context) : a.context;
        // New format: ceo_decision with decision field
        if (ctx?.ceo_decision?.decision === "expansion" || ctx?.ceo_decision?.decision === "question") return true;
        // Legacy format: proposal_type on the proposal itself
        const p = ctx?.proposal || ctx;
        return p?.proposal_type === "expansion" || p?.proposal_type === "question";
      } catch { return false; }
    }
    return false;
  };
  const ideas = approvals.filter(isScoutProposal);
  const otherApprovals = approvals.filter(a => !isScoutProposal(a));
  const inboxCount = approvals.length + evolverProposals.length + blockerCount;
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--hive-amber)", animation: "pulse 1.5s ease infinite" }} />
          <span style={{ fontFamily: "var(--hive-mono)", fontSize: 11, color: "var(--hive-text-tertiary)", letterSpacing: "0.1em" }}>LOADING</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--hive-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--hive-mono)", fontSize: 11, color: "var(--hive-red)", letterSpacing: "0.1em" }}>FAILED TO LOAD</span>
          <span style={{ fontFamily: "var(--hive-mono)", fontSize: 10, color: "var(--hive-text-dim)" }}>/api/dashboard returned an error</span>
          <button onClick={() => { setLoadError(false); setLoading(true); fetchAll(); }}
            style={{ marginTop: 4, fontFamily: "var(--hive-mono)", fontSize: 10, color: "var(--hive-amber)", background: "none", border: "1px solid var(--hive-amber-border)", borderRadius: 4, padding: "4px 12px", cursor: "pointer" }}>
            RETRY
          </button>
        </div>
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
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--hive-text)", letterSpacing: "-0.02em" }}>Hive</div>
        </div>
        {portfolio && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-text-secondary)" }}>
            <span>MRR <span style={{ fontWeight: 600, color: portfolio.total_mrr > 0 ? "var(--hive-green)" : "var(--hive-text-tertiary)" }}>{fmtCurrency(portfolio.total_mrr)}</span></span>
            <span style={{ color: "var(--hive-text-dim)" }}>·</span>
            <span>Customers <span style={{ fontWeight: 600, color: "var(--hive-text)" }}>{portfolio.total_customers}</span></span>
            <span style={{ color: "var(--hive-text-dim)" }}>·</span>
            <span>Companies <span style={{ fontWeight: 600, color: "var(--hive-text)" }}>{portfolio.live_companies}</span></span>
            <span style={{ color: "var(--hive-text-dim)" }}>·</span>
            <span>Last cycle <span style={{ fontWeight: 600, color: "var(--hive-text)" }}>{portfolio.last_cycle_at ? timeAgo(portfolio.last_cycle_at) : "—"}</span></span>
          </div>
        )}
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
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: "1px solid var(--hive-border-subtle)" }}>
        <TabButton label="Overview" active={activeTab === "overview"} onClick={() => setActiveTab("overview")} />
        <TabButton label="Inbox" active={activeTab === "inbox"} count={inboxCount} onClick={() => setActiveTab("inbox")} />
        <TabButton label="Activity" active={activeTab === "activity"} onClick={() => setActiveTab("activity")} />
        <TabButton label="Intelligence" active={activeTab === "intelligence"} onClick={() => setActiveTab("intelligence")} />
      </div>

      {/* ==================== OVERVIEW TAB ==================== */}
      {activeTab === "overview" && (
        <div className="animate-in">
          {/* Needs your attention */}
          {todos.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                  letterSpacing: "0.06em", textTransform: "uppercase" }}>Needs your attention</div>
                <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                  padding: "1px 6px", borderRadius: 8, minWidth: 18, textAlign: "center",
                  background: blockerCount > 0 ? "var(--hive-red-bg)" : "var(--hive-amber-bg)",
                  color: blockerCount > 0 ? "var(--hive-red)" : "var(--hive-amber)",
                  border: `1px solid ${blockerCount > 0 ? "var(--hive-red-border)" : "var(--hive-amber-border)"}` }}>
                  {todos.length}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {todos.slice(0, showAllTodos ? todos.length : 5).map(todo => {
                  const sc = {
                    blocker: { border: "#f87171", bg: "rgba(248,113,113,0.06)" },
                    warning: { border: "#f0b944", bg: "rgba(240,185,68,0.06)" },
                    info: { border: "#60a5fa", bg: "rgba(96,165,250,0.06)" },
                  }[todo.severity];
                  const catLabel = {
                    setup: "Setup", manual_action: "Action needed", health: "Health", agent: "Agent issue",
                  }[todo.category];

                  return (
                    <div key={todo.id} style={{
                      padding: "14px 16px", background: sc.bg, borderLeft: `3px solid ${sc.border}`,
                      borderRadius: 8, display: "flex", alignItems: "flex-start", gap: 12,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.04em",
                            padding: "1px 7px", borderRadius: 4, color: sc.border, background: sc.bg,
                            border: `1px solid ${sc.border}30` }}>{catLabel}</span>
                          {todo.company_slug && (
                            <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: "var(--hive-text-tertiary)" }}>{todo.company_slug}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--hive-text)", marginBottom: 2 }}>{todo.title}</div>
                        <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.5,
                          overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as React.CSSProperties}>
                          {todo.detail}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                        {todo.action_url && (
                          <Link href={todo.action_url} style={{ textDecoration: "none" }}>
                            <button style={{
                              padding: "6px 12px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer", border: `1px solid ${sc.border}40`,
                              background: sc.bg, color: sc.border, letterSpacing: "0.02em",
                            }}>{todo.action_label || "View"}</button>
                          </Link>
                        )}
                        {todo.dismissable && (
                          <button onClick={() => dismissTodo(todo.id)} style={{
                            width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 16, fontFamily: "var(--hive-mono)", borderRadius: 6, cursor: "pointer",
                            border: "1px solid var(--hive-border)", background: "transparent",
                            color: "var(--hive-text-tertiary)", lineHeight: 1,
                          }} title="Dismiss">×</button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {todos.length > 5 && (
                  <button onClick={() => setShowAllTodos(!showAllTodos)} style={{
                    fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-text-secondary)",
                    background: "none", border: "none", cursor: "pointer", padding: "6px 0",
                  }}>{showAllTodos ? "Show less" : `Show ${todos.length - 5} more`}</button>
                )}
              </div>
            </div>
          )}

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

          {/* Scout cleanup warning when too many proposals */}
          {ideas.length > 5 && (
            <div style={{
              padding: "12px 16px", marginBottom: 20, borderRadius: 10,
              background: "var(--hive-red-bg)", border: "1px solid var(--hive-red-border)",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14 }}>⚠️</span>
                <span style={{ fontSize: 13, color: "var(--hive-red)" }}>
                  {ideas.length} Scout proposals pending — pipeline clogged, blocking company execution
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={async () => {
                    if (confirm(`Expire old Scout proposals, keeping only 2 newest?`)) {
                      try {
                        const res = await fetch('/api/approvals/scout-cleanup', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            max_pending: 2,
                            min_age_hours: 24,
                            reason: 'Manual cleanup by Carlos via dashboard'
                          })
                        });
                        if (res.ok) {
                          const data = await res.json();
                          alert(`✅ Cleanup complete: expired ${data.expired_count} proposals`);
                          window.location.reload();
                        } else {
                          alert('❌ Cleanup failed');
                        }
                      } catch (e) {
                        alert('❌ Cleanup failed');
                      }
                    }
                  }}
                  style={{
                    padding: "6px 12px", fontSize: 12, fontWeight: 500, borderRadius: 6,
                    background: "var(--hive-red)", color: "white", border: "none", cursor: "pointer"
                  }}
                >
                  Cleanup
                </button>
                <button
                  onClick={async () => {
                    if (confirm('⚠️ NUCLEAR OPTION: Expire ALL Scout proposals and kill ALL idea companies?')) {
                      try {
                        const res = await fetch('/api/admin/scout-reset', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            reason: 'Manual Scout reset by Carlos via dashboard'
                          })
                        });
                        if (res.ok) {
                          const data = await res.json();
                          alert(`🔴 Scout reset complete: ${data.expired_proposals} proposals expired, ${data.killed_companies} companies killed`);
                          window.location.reload();
                        } else {
                          alert('❌ Reset failed');
                        }
                      } catch (e) {
                        alert('❌ Reset failed');
                      }
                    }
                  }}
                  style={{
                    padding: "6px 12px", fontSize: 12, fontWeight: 500, borderRadius: 6,
                    background: "#8b0000", color: "white", border: "none", cursor: "pointer"
                  }}
                >
                  Reset All
                </button>
              </div>
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
                {portfolioCompanies.map(c => {
                  const m = c.latest_metrics;
                  const isLive = ["active", "mvp"].includes(c.status);
                  const score = getCeoScore(c.id);
                  const cycleCount = getCycleCount(c.id);
                  const scoreColor = score !== null ? (score >= 7 ? "var(--hive-green)" : score >= 4 ? "var(--hive-amber)" : "var(--hive-red)") : "var(--hive-text-tertiary)";

                  return (
                    <Link key={c.id} href={`/company/${c.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
                      <div style={{
                        padding: "16px 18px", background: "var(--hive-surface)", borderRadius: 10,
                        borderTop: "1px solid var(--hive-border)", borderRight: "1px solid var(--hive-border)",
                        borderBottom: "1px solid var(--hive-border)",
                        borderLeft: `3px solid ${STATUS_MAP[c.status]?.color || "#9d9da8"}`,
                        transition: "background 0.15s", cursor: "pointer",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--hive-surface-hover)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--hive-surface)"; }}>
                        {/* Top line: name + badge | CEO score */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--hive-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                            <StatusBadge status={c.status} />
                          </div>
                          {score !== null && (
                            <div style={{ display: "flex", alignItems: "baseline", gap: 4, flexShrink: 0 }}>
                              <span style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--hive-mono)", color: scoreColor, lineHeight: 1 }}>{score}</span>
                              <span style={{ fontSize: 10, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>CEO</span>
                            </div>
                          )}
                        </div>

                        {/* Mini metrics row */}
                        {isLive && (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                            <div>
                              <div style={{ fontSize: 10, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>MRR</div>
                              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--hive-mono)", color: (m?.mrr || 0) > 0 ? "var(--hive-green)" : "var(--hive-text-tertiary)" }}>{fmtCurrency(m?.mrr || 0)}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>{(m?.customers || 0) > 0 ? "Customers" : (m?.waitlist_total || 0) > 0 ? "Waitlist" : "Customers"}</div>
                              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--hive-mono)" }}>{(m?.customers || 0) > 0 ? m.customers : (m?.waitlist_total || 0) > 0 ? m.waitlist_total : 0}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 2 }}>Views</div>
                              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "var(--hive-mono)" }}>{m?.page_views || 0}</div>
                            </div>
                          </div>
                        )}

                        {c.status === "provisioning" && (
                          <div style={{ fontSize: 12, color: "var(--hive-amber)", marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--hive-amber)", animation: "pulse 1.5s ease infinite" }} />
                            Provisioning...
                          </div>
                        )}

                        {/* Task progress */}
                        {Number(c.tasks_total) > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                              <span style={{ fontSize: 10, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Tasks</span>
                              <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: "var(--hive-text-secondary)" }}>
                                {Number(c.tasks_done)}/{Number(c.tasks_total)}
                              </span>
                            </div>
                            <div style={{ height: 4, borderRadius: 2, background: "var(--hive-border)", overflow: "hidden" }}>
                              <div style={{
                                height: "100%", borderRadius: 2, transition: "width 0.3s",
                                width: `${Math.round((Number(c.tasks_done) / Number(c.tasks_total)) * 100)}%`,
                                background: Number(c.tasks_done) === Number(c.tasks_total) ? "var(--hive-green)" : "var(--hive-amber)",
                              }} />
                            </div>
                          </div>
                        )}

                        {/* Footer: cycles + pending approvals */}
                        <div style={{ paddingTop: 10, borderTop: "1px solid var(--hive-border-subtle)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                              {cycleCount} cycle{cycleCount !== 1 ? "s" : ""}
                            </div>
                            {(c.pending_approvals || 0) > 0 && (
                              <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                                padding: "2px 8px", borderRadius: 8,
                                background: "var(--hive-amber-bg)", color: "var(--hive-amber)", border: "1px solid var(--hive-amber-border)" }}>
                                {c.pending_approvals} pending
                              </span>
                            )}
                          </div>
                          {(c.pending_approval_details?.length || 0) > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                              {c.pending_approval_details.map((a, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                                  <span style={{
                                    fontSize: 9, fontFamily: "var(--hive-mono)", fontWeight: 600, textTransform: "uppercase",
                                    padding: "1px 5px", borderRadius: 4, letterSpacing: "0.03em",
                                    background: a.gate_type === "kill_company" ? "var(--hive-red-bg, rgba(239,68,68,0.1))" : "var(--hive-surface-hover)",
                                    color: a.gate_type === "kill_company" ? "var(--hive-red)" : "var(--hive-text-secondary)",
                                    border: `1px solid ${a.gate_type === "kill_company" ? "var(--hive-red-border, rgba(239,68,68,0.2))" : "var(--hive-border)"}`,
                                  }}>{a.gate_type.replace(/_/g, " ")}</span>
                                  <span style={{ color: "var(--hive-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {a.title}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Neon usage */}
          {neonUsage && !neonUsage.error && neonUsage.projects.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Neon DB usage</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {neonUsage.projects.map(p => (
                  <div key={p.id} style={{ padding: "12px 14px", borderRadius: 8, background: "var(--hive-surface)", border: "1px solid var(--hive-border)" }}>
                    <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-text-secondary)", marginBottom: 8 }}>{p.name}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {/* Storage bar */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                          <span style={{ fontSize: 11, color: "var(--hive-text-dim)" }}>Storage</span>
                          <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: p.storage_pct >= 80 ? "var(--hive-red)" : "var(--hive-text-secondary)" }}>
                            {p.storage_gb.toFixed(3)} GB / {neonUsage.limits.storage_gb_per_project} GB ({p.storage_pct}%)
                          </span>
                        </div>
                        <div style={{ height: 4, borderRadius: 2, background: "var(--hive-border)", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${p.storage_pct}%`, borderRadius: 2,
                            background: p.storage_pct >= 80 ? "var(--hive-red)" : p.storage_pct >= 60 ? "#f59e0b" : "var(--hive-accent)" }} />
                        </div>
                      </div>
                      {/* Compute bar */}
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                          <span style={{ fontSize: 11, color: "var(--hive-text-dim)" }}>Compute</span>
                          <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: p.compute_pct >= 80 ? "var(--hive-red)" : "var(--hive-text-secondary)" }}>
                            {p.compute_hours.toFixed(2)} hrs / {neonUsage.limits.compute_hours_per_month} hrs ({p.compute_pct}%)
                          </span>
                        </div>
                        <div style={{ height: 4, borderRadius: 2, background: "var(--hive-border)", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${p.compute_pct}%`, borderRadius: 2,
                            background: p.compute_pct >= 80 ? "var(--hive-red)" : p.compute_pct >= 60 ? "#f59e0b" : "var(--hive-accent)" }} />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
                {actions.slice(0, 8).map(a => {
                  const isFail = a.status === "failed";
                  return (
                    <div key={a.id} style={{
                      display: "flex", gap: 12, padding: "10px 14px", borderRadius: 8,
                      background: isFail ? "var(--hive-red-bg)" : "transparent",
                    }}>
                      <div style={{ minWidth: 70 }}><AgentBadge agent={a.agent} /></div>
                      <div style={{ flex: 1, fontSize: 13, color: isFail ? "var(--hive-red)" : "var(--hive-text-secondary)", lineHeight: 1.5 }}>
                        {a.description || ''}
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
          {/* Batch action bar */}
          {approvals.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16,
              padding: "10px 14px", borderRadius: 8, background: "var(--hive-surface)", border: "1px solid var(--hive-border)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12,
                fontFamily: "var(--hive-mono)", color: "var(--hive-text-secondary)" }}>
                <input type="checkbox" checked={selectedApprovals.size === approvals.length && approvals.length > 0}
                  onChange={toggleSelectAll}
                  style={{ accentColor: "var(--hive-amber)", width: 14, height: 14, cursor: "pointer" }} />
                Select all ({approvals.length})
              </label>
              {selectedApprovals.size > 0 && (
                <>
                  <span style={{ fontSize: 12, fontFamily: "var(--hive-mono)", color: "var(--hive-text-dim)" }}>
                    {selectedApprovals.size} selected
                  </span>
                  <button onClick={handleBatchReject} disabled={batchProcessing} style={{
                    marginLeft: "auto", padding: "6px 16px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                    borderRadius: 6, cursor: batchProcessing ? "wait" : "pointer",
                    border: "1px solid var(--hive-red-border)", background: "var(--hive-red-bg)", color: "var(--hive-red)",
                    opacity: batchProcessing ? 0.6 : 1,
                  }}>{batchProcessing ? "Rejecting..." : "Reject Selected"}</button>
                </>
              )}
            </div>
          )}
          {approvals.length === 0 && evolverProposals.length === 0 ? (
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
                      let proposal: any = {};
                      let research: any = {};
                      try {
                        const ctx = typeof a.context === "string" ? JSON.parse(a.context) : a.context;
                        // Handle both formats: {proposal: {...}, research: {...}} and flat {name, slug, ...}
                        if (ctx?.proposal) {
                          proposal = ctx.proposal;
                          research = ctx.research || {};
                        } else if (ctx?.name && ctx?.slug) {
                          // Flat format — the context IS the proposal (backward compat)
                          proposal = ctx;
                          research = ctx.research || {};
                        }
                      } catch { /* fall back to plain text */ }
                      const confidence = proposal.confidence || 0;
                      const confidencePct = Math.round(confidence * 100);
                      const confidenceColor = confidence >= 0.7 ? "var(--hive-green)" : confidence >= 0.5 ? "var(--hive-amber)" : "var(--hive-red)";
                      const confidenceBg = confidence >= 0.7 ? "var(--hive-green-bg)" : confidence >= 0.5 ? "var(--hive-amber-bg)" : "var(--hive-red-bg)";
                      const confidenceBorder = confidence >= 0.7 ? "var(--hive-green-border)" : confidence >= 0.5 ? "var(--hive-amber-border)" : "var(--hive-red-border)";
                      const isPortuguese = proposal.market === "pt" || proposal.market === "Portugal" || a.description?.toLowerCase().includes("portug");
                      const hasRichData = proposal.problem || proposal.solution || proposal.monetisation || proposal.mvp_scope;
                      const businessModel = proposal.business_model || "saas";
                      const modelLabels: Record<string, string> = {
                        saas: "SaaS", blog: "Blog", digital_product: "Digital Product", faceless_channel: "Faceless Channel",
                        virtual_influencer: "Virtual Influencer", affiliate_site: "Affiliate", newsletter: "Newsletter",
                        dropshipping: "Dropshipping", api_service: "API Service", marketplace: "Marketplace",
                      };
                      const automationScore = proposal.automation_score || 0;
                      const automationPct = Math.round(automationScore * 100);
                      // Read decision from CEO evaluation (new format) or legacy proposal_type
                      const ceoDecision = (() => {
                        try {
                          const ctx = typeof a.context === "string" ? JSON.parse(a.context) : a.context;
                          return ctx?.ceo_decision?.decision || proposal.proposal_type || "new_company";
                        } catch { return proposal.proposal_type || "new_company"; }
                      })();
                      const expandTarget = (() => {
                        try {
                          const ctx = typeof a.context === "string" ? JSON.parse(a.context) : a.context;
                          return ctx?.ceo_decision?.expand_target || proposal.expand_target || proposal.expansion_candidate?.target_slug || "";
                        } catch { return ""; }
                      })();
                      const questionForCarlos = (() => {
                        try {
                          const ctx = typeof a.context === "string" ? JSON.parse(a.context) : a.context;
                          return ctx?.ceo_decision?.question_for_carlos || proposal.question_for_carlos || "";
                        } catch { return ""; }
                      })();
                      const isExpansion = ceoDecision === "expansion";
                      const isQuestion = ceoDecision === "question";
                      return (
                        <div key={a.id} style={{
                          padding: 20, borderRadius: 10,
                          background: "var(--hive-amber-bg)", border: `1px solid ${selectedApprovals.has(a.id) ? "var(--hive-amber)" : "var(--hive-amber-border)"}`,
                        }}>
                          {/* Header: name + badges */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <input type="checkbox" checked={selectedApprovals.has(a.id)}
                                onChange={() => toggleApprovalSelection(a.id)}
                                style={{ accentColor: "var(--hive-amber)", width: 14, height: 14, cursor: "pointer", flexShrink: 0 }} />
                              <span style={{ fontSize: 16 }}>{isPortuguese ? "🇵🇹" : "🌍"}</span>
                              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--hive-text)" }}>
                                {proposal.name || a.title}
                              </span>
                            </div>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              {confidencePct > 0 && (
                                <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 600,
                                  padding: "2px 10px", borderRadius: 4,
                                  background: confidenceBg, color: confidenceColor, border: `1px solid ${confidenceBorder}` }}>
                                  {confidencePct}%
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Type + Model + automation tags */}
                          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                            {(isExpansion || isQuestion) && (
                              <span style={{ fontSize: 10, fontFamily: "var(--hive-mono)", fontWeight: 600,
                                padding: "2px 8px", borderRadius: 4,
                                background: isQuestion ? "rgba(245,158,11,0.15)" : "rgba(59,130,246,0.15)",
                                color: isQuestion ? "rgb(245,158,11)" : "rgb(59,130,246)",
                                border: `1px solid ${isQuestion ? "rgba(245,158,11,0.3)" : "rgba(59,130,246,0.3)"}` }}>
                                {isQuestion ? "❓ Decision needed" : `📈 Expand ${expandTarget}`}
                              </span>
                            )}
                            <span style={{ fontSize: 10, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              padding: "2px 8px", borderRadius: 4,
                              background: "rgba(139,92,246,0.15)", color: "rgb(139,92,246)", border: "1px solid rgba(139,92,246,0.3)" }}>
                              {modelLabels[businessModel] || businessModel}
                            </span>
                            {automationPct > 0 && (
                              <span style={{ fontSize: 10, fontFamily: "var(--hive-mono)", fontWeight: 500,
                                padding: "2px 8px", borderRadius: 4,
                                background: automationPct >= 90 ? "var(--hive-green-bg)" : "var(--hive-amber-bg)",
                                color: automationPct >= 90 ? "var(--hive-green)" : "var(--hive-amber)",
                                border: `1px solid ${automationPct >= 90 ? "var(--hive-green-border)" : "var(--hive-amber-border)"}` }}>
                                {automationPct}% automatable
                              </span>
                            )}
                            {proposal.revenue_streams && proposal.revenue_streams.length > 1 && (
                              <span style={{ fontSize: 10, fontFamily: "var(--hive-mono)", fontWeight: 500,
                                padding: "2px 8px", borderRadius: 4,
                                background: "rgba(59,130,246,0.15)", color: "rgb(59,130,246)", border: "1px solid rgba(59,130,246,0.3)" }}>
                                {proposal.revenue_streams.length} revenue streams
                              </span>
                            )}
                          </div>

                          {/* Description */}
                          <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6, marginBottom: hasRichData ? 14 : 10 }}>
                            {proposal.description || a.description}
                          </div>

                          {/* Question for Carlos (decision-type proposals) */}
                          {questionForCarlos && (
                            <div style={{ padding: "12px 14px", borderRadius: 8, marginBottom: 14,
                              background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "rgb(245,158,11)", marginBottom: 6 }}>Decision needed:</div>
                              <div style={{ fontSize: 12, color: "var(--hive-text-secondary)", lineHeight: 1.6 }}>
                                {questionForCarlos}
                              </div>
                            </div>
                          )}

                          {/* Rich detail fields */}
                          {hasRichData && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14,
                              padding: "12px 14px", borderRadius: 8, background: "rgba(0,0,0,0.12)" }}>
                              {proposal.problem && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>Problem:</strong> {proposal.problem}
                                </div>
                              )}
                              {proposal.solution && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>Solution:</strong> {proposal.solution}
                                </div>
                              )}
                              {proposal.monetisation && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>Revenue:</strong> {proposal.monetisation}
                                </div>
                              )}
                              {proposal.mvp_scope && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>MVP:</strong> {proposal.mvp_scope}
                                </div>
                              )}
                              {proposal.tam && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>TAM:</strong> {proposal.tam}
                                </div>
                              )}
                              {proposal.automation_plan && (
                                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", lineHeight: 1.5 }}>
                                  <strong style={{ color: "var(--hive-text-secondary)", fontWeight: 600 }}>Automation:</strong> {proposal.automation_plan}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Portfolio synergy */}
                          {proposal.portfolio_synergy && proposal.portfolio_synergy.synergy_score > 0 && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
                              padding: "8px 12px", borderRadius: 6,
                              background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)" }}>
                              <span style={{ fontSize: 14 }}>🔗</span>
                              <div style={{ fontSize: 11, color: "rgb(59,130,246)", lineHeight: 1.4 }}>
                                <strong>Synergy {Math.round(proposal.portfolio_synergy.synergy_score * 100)}%</strong>
                                {proposal.portfolio_synergy.related_companies?.length > 0 && (
                                  <span> with {proposal.portfolio_synergy.related_companies.join(", ")}</span>
                                )}
                                {proposal.portfolio_synergy.cross_sell_opportunity && (
                                  <span> — {proposal.portfolio_synergy.cross_sell_opportunity}</span>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Research stats */}
                          {(research.sources_consulted || research.searches_performed || research.niches_considered) && (
                            <div style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: "var(--hive-text-dim)", marginBottom: 14 }}>
                              Research: {Array.isArray(research.sources_consulted) ? `${research.sources_consulted.length} sources` : ""}
                              {Array.isArray(research.sources_consulted) && (Array.isArray(research.searches_performed) || research.searches_performed) ? " · " : ""}
                              {Array.isArray(research.searches_performed) ? `${research.searches_performed.length} searches` : (research.searches_performed ? `${research.searches_performed} searches` : "")}
                              {(Array.isArray(research.pages_fetched) && research.pages_fetched.length > 0) ? ` · ${research.pages_fetched.length} pages fetched` : ""}
                              {(Array.isArray(research.key_signals) && research.key_signals.length > 0) ? ` · ${research.key_signals.length} signals` : ""}
                              {Array.isArray(research.niches_considered) ? ` · ${research.niches_considered.length} niches` : (research.niches_considered ? ` · ${research.niches_considered} niches` : "")}
                            </div>
                          )}

                          {/* Action buttons */}
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

              {/* Evolver proposals */}
              {evolverProposals.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                    letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Evolver proposals</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {evolverProposals.map(p => {
                      const severityColors: Record<string, { color: string; bg: string; border: string }> = {
                        critical: { color: "var(--hive-red)", bg: "var(--hive-red-bg)", border: "var(--hive-red-border)" },
                        high: { color: "var(--hive-amber)", bg: "var(--hive-amber-bg)", border: "var(--hive-amber-border)" },
                        medium: { color: "var(--hive-blue)", bg: "var(--hive-blue-bg)", border: "var(--hive-blue-border)" },
                        low: { color: "var(--hive-text-tertiary)", bg: "rgba(108,108,120,0.08)", border: "rgba(108,108,120,0.18)" },
                      };
                      const sc = severityColors[p.severity] || severityColors.medium;
                      const gapLabels: Record<string, string> = { outcome: "Outcome gap", capability: "Capability gap", knowledge: "Knowledge gap", process: "Process gap" };
                      return (
                        <div key={p.id} style={{
                          padding: 20, borderRadius: 10,
                          background: "var(--hive-purple-bg)", border: "1px solid var(--hive-purple-border)",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              padding: "2px 8px", borderRadius: 4, color: "var(--hive-purple)", background: "var(--hive-purple-bg)", border: "1px solid var(--hive-purple-border)" }}>
                              {gapLabels[p.gap_type] || p.gap_type}
                            </span>
                            <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              padding: "2px 8px", borderRadius: 4, color: sc.color, background: sc.bg, border: `1px solid ${sc.border}` }}>
                              {p.severity}
                            </span>
                            {p.cross_company && (
                              <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500,
                                padding: "2px 8px", borderRadius: 4, color: "var(--hive-text-tertiary)", background: "rgba(108,108,120,0.08)", border: "1px solid rgba(108,108,120,0.18)" }}>
                                cross-company
                              </span>
                            )}
                            <span style={{ fontSize: 12, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", marginLeft: "auto" }}>{timeAgo(p.created_at)}</span>
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--hive-text)", marginBottom: 4 }}>{p.title}</div>
                          <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6, marginBottom: 10 }}>{p.diagnosis}</div>
                          {p.proposed_fix && (
                            <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", marginBottom: 14, padding: "8px 12px", borderRadius: 6, background: "rgba(108,108,120,0.06)" }}>
                              <strong style={{ color: "var(--hive-text-secondary)" }}>Fix:</strong> {p.proposed_fix.change}
                              {p.proposed_fix.expected_impact && (
                                <span style={{ marginLeft: 8, color: "var(--hive-text-dim)" }}>({p.proposed_fix.expected_impact})</span>
                              )}
                            </div>
                          )}
                          {p.affected_companies?.length > 0 && (
                            <div style={{ fontSize: 12, color: "var(--hive-text-dim)", marginBottom: 14 }}>
                              Affects: {p.affected_companies.join(", ")}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => handleProposalDecision(p.id, "approved")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-green-border)", background: "var(--hive-green-bg)", color: "var(--hive-green)",
                            }}>Approve</button>
                            <button onClick={() => handleProposalDecision(p.id, "deferred")} style={{
                              padding: "8px 20px", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
                              borderRadius: 6, cursor: "pointer",
                              border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-text-tertiary)",
                            }}>Defer</button>
                            <button onClick={() => handleProposalDecision(p.id, "rejected")} style={{
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

              {/* Other approvals */}
              {otherApprovals.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-text-secondary)",
                    letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 12 }}>Pending approvals</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {otherApprovals.map(a => {
                      const gc = GATE_COLORS[a.gate_type] || { color: "var(--hive-text-secondary)", bg: "var(--hive-surface)", border: "var(--hive-border)" };
                      return (
                        <div key={a.id} style={{ padding: 20, borderRadius: 10, background: gc.bg, border: `1px solid ${selectedApprovals.has(a.id) ? gc.color : gc.border}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <input type="checkbox" checked={selectedApprovals.has(a.id)}
                              onChange={() => toggleApprovalSelection(a.id)}
                              style={{ accentColor: gc.color, width: 14, height: 14, cursor: "pointer", flexShrink: 0 }} />
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
                          <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>{a.description || ''}</div>
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
                              {a.description || ''}
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

      {/* ==================== TASKS TAB ==================== */}

      {/* Footer */}
      <div style={{ marginTop: 40, paddingTop: 16, borderTop: "1px solid var(--hive-border-subtle)",
        display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
        <span>hive v0.2.0 · event-driven</span>
        <span>neon · vercel · claude max 5x · github actions</span>
      </div>
    </div>
  );
}
