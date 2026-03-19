"use client";
import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Company = {
  id: string; name: string; slug: string; description: string; status: string;
  vercel_url: string | null; created_at: string; killed_at: string | null; kill_reason: string | null;
};
type Cycle = {
  id: string; cycle_number: number; status: string; ceo_plan: any; ceo_review: any;
  started_at: string; finished_at: string | null;
};
type Action = {
  id: string; agent: string; action_type: string; description: string; status: string;
  error: string | null; reflection: string | null; tokens_used: number; finished_at: string;
};
type Metric = {
  date: string; revenue: number; mrr: number; customers: number;
  page_views: number; signups: number; churn_rate: number;
};
type Approval = {
  id: string; gate_type: string; title: string; description: string; status: string; created_at: string;
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
const AGENT_MAP: Record<string, { label: string; color: string }> = {
  ceo: { label: "CEO", color: "#f0b944" },
  scout: { label: "Scout", color: "#60a5fa" },
  engineer: { label: "Engineer", color: "#34d399" },
  growth: { label: "Growth", color: "#a78bfa" },
  ops: { label: "Ops", color: "#f472b6" },
  outreach: { label: "Outreach", color: "#fb923c" },
  evolver: { label: "Evolver", color: "#38bdf8" },
};

function timeAgo(ts: string) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
}

export default function CompanyDetailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [company, setCompany] = useState<Company | null>(null);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [research, setResearch] = useState<Array<{ id: string; report_type: string; summary: string | null; content: any; updated_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [directive, setDirective] = useState("");
  const [sending, setSending] = useState(false);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/dashboard?slug=${slug}`);
    if (!res.ok) { setLoading(false); return; }
    const { data } = await res.json();
    if (!data.company) { setLoading(false); return; }
    setCompany(data.company);
    setCycles(data.cycles || []);
    setActions(data.actions || []);
    setMetrics(data.metrics || []);
    setApprovals(data.approvals || []);
    setResearch(data.research || []);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    fetchData();
    let interval = setInterval(fetchData, 120_000);
    const onVisibility = () => {
      clearInterval(interval);
      if (document.visibilityState === "visible") {
        fetchData();
        interval = setInterval(fetchData, 120_000);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchData]);

  const sendDirective = async () => {
    if (!directive.trim() || !company) return;
    setSending(true);
    await fetch("/api/directives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: company.id, text: directive }),
    });
    setDirective("");
    setSending(false);
    fetchData();
  };

  const handleApproval = async (id: string, decision: "approved" | "rejected") => {
    await fetch(`/api/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    fetchData();
  };

  if (loading) return <div style={{ padding: 40, fontFamily: "var(--hive-sans)", color: "var(--hive-text-secondary)", fontSize: 13 }}>Loading...</div>;
  if (!company) return <div style={{ padding: 40, fontFamily: "var(--hive-sans)", color: "var(--hive-red)", fontSize: 13 }}>Company &quot;{slug}&quot; not found</div>;

  const status = STATUS_MAP[company.status] || STATUS_MAP.idea;
  const pendingApprovals = approvals.filter(a => a.status === "pending");
  const latestMetrics = metrics.slice(0, 10);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px", fontFamily: "var(--hive-sans)", color: "var(--hive-text)", background: "var(--hive-bg)", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link href="/" style={{ color: "var(--hive-text-secondary)", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--hive-text)", margin: 0 }}>{company.name}</h1>
          <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.06em",
            padding: "2px 8px", borderRadius: 4, color: status.color, background: status.color + "14", border: `1px solid ${status.color}2a` }}>
            {status.label}
          </span>
        </div>
        <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginTop: 4 }}>{company.description}</div>
        <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", marginTop: 6, display: "flex", gap: 16, fontFamily: "var(--hive-mono)" }}>
          {company.vercel_url && <a href={company.vercel_url} target="_blank" rel="noreferrer" style={{ color: "var(--hive-amber)", textDecoration: "none" }}>{company.vercel_url}</a>}
          <span>Created {timeAgo(company.created_at)}</span>
          {company.killed_at && <span style={{ color: "var(--hive-red)" }}>Killed {timeAgo(company.killed_at)}: {company.kill_reason}</span>}
        </div>
      </div>

      {/* Directive input */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={directive} onChange={e => setDirective(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") sendDirective(); }}
            placeholder={`Send directive to ${company.name}...`}
            style={{ flex: 1, padding: "10px 14px", background: "var(--hive-surface)", border: "1px solid var(--hive-border)", borderRadius: 8,
              color: "var(--hive-text)", fontSize: 13, fontFamily: "var(--hive-mono)", outline: "none", transition: "border-color 0.15s" }}
            onFocus={e => { e.target.style.borderColor = "var(--hive-amber-border)"; }}
            onBlur={e => { e.target.style.borderColor = "var(--hive-border)"; }}
          />
          <button onClick={sendDirective} disabled={sending || !directive.trim()}
            style={{ padding: "10px 20px", background: "var(--hive-amber-bg)", border: "1px solid var(--hive-amber-border)",
              borderRadius: 8, color: "var(--hive-amber)", fontSize: 13, fontFamily: "var(--hive-mono)", fontWeight: 500, cursor: "pointer",
              opacity: directive.trim() ? 1 : 0.4 }}>
            Send
          </button>
        </div>
      </div>

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div style={{ marginBottom: 24, padding: 20, background: "var(--hive-amber-bg)", border: "1px solid var(--hive-amber-border)", borderRadius: 10 }}>
          <h3 style={{ fontSize: 14, color: "var(--hive-amber)", margin: "0 0 12px", fontWeight: 500 }}>
            {pendingApprovals.length} pending approval{pendingApprovals.length > 1 ? "s" : ""}
          </h3>
          {pendingApprovals.map(a => (
            <div key={a.id} style={{ marginBottom: 12, padding: 14, background: "var(--hive-bg)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
              <div style={{ fontSize: 13, color: "var(--hive-text)", marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", padding: "2px 7px", borderRadius: 4,
                  background: "var(--hive-purple-bg)", color: "var(--hive-purple)", border: "1px solid var(--hive-purple-border)", marginRight: 8 }}>{a.gate_type}</span>
                {a.title}
              </div>
              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginBottom: 10, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{a.description.slice(0, 300)}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => handleApproval(a.id, "approved")}
                  style={{ padding: "6px 16px", background: "var(--hive-green-bg)", border: "1px solid var(--hive-green-border)",
                    borderRadius: 6, color: "var(--hive-green)", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, cursor: "pointer" }}>
                  Approve
                </button>
                <button onClick={() => handleApproval(a.id, "rejected")}
                  style={{ padding: "6px 16px", background: "var(--hive-red-bg)", border: "1px solid var(--hive-red-border)",
                    borderRadius: 6, color: "var(--hive-red)", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, cursor: "pointer" }}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Metrics */}
      {latestMetrics.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: "0 0 12px", fontWeight: 500 }}>Latest metrics</h3>
          {(() => {
            const latest = latestMetrics[0];
            const metricItems = [
              { label: "MRR", value: `€${latest.mrr}`, highlight: latest.mrr > 0 },
              { label: "Revenue", value: `€${latest.revenue}`, highlight: latest.revenue > 0 },
              { label: "Customers", value: latest.customers, highlight: latest.customers > 0 },
              { label: "Page views", value: latest.page_views, highlight: false },
              { label: "Signups", value: latest.signups, highlight: latest.signups > 0 },
              { label: "Churn", value: `${(latest.churn_rate * 100).toFixed(1)}%`, highlight: false },
            ];
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                {metricItems.map((m, i) => (
                  <div key={i} style={{ padding: "12px 14px", background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                    <div style={{ fontSize: 18, fontWeight: 600, fontFamily: "var(--hive-mono)", color: m.highlight ? "var(--hive-green)" : "var(--hive-text)" }}>{m.value}</div>
                    <div style={{ fontSize: 12, color: "var(--hive-text-secondary)", marginTop: 2 }}>{m.label}</div>
                    <div style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>{latest.date}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Research Reports */}
      {research.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: "0 0 12px", fontWeight: 500 }}>Research intelligence</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {research.map(r => {
              const icons: Record<string, string> = {
                market_research: "📊", competitive_analysis: "🎯", seo_keywords: "🔍",
                lead_list: "📧", outreach_log: "✉",
              };
              const labels: Record<string, string> = {
                market_research: "Market research", competitive_analysis: "Competitive analysis",
                seo_keywords: "SEO keywords", lead_list: "Lead pipeline", outreach_log: "Outreach log",
              };
              const content = typeof r.content === "string" ? JSON.parse(r.content) : r.content;

              let stats = "";
              if (r.report_type === "competitive_analysis" && content.direct_competitors) {
                stats = `${content.direct_competitors.length} competitors mapped`;
              } else if (r.report_type === "seo_keywords" && content.primary_keywords) {
                stats = `${content.primary_keywords.length} keywords, ${content.content_ideas?.length || 0} content ideas`;
              } else if (r.report_type === "lead_list" && content.leads) {
                const contacted = content.leads.filter((l: any) => l.status !== "new").length;
                stats = `${content.leads.length} leads (${contacted} contacted)`;
              } else if (r.report_type === "outreach_log" && content.emails_drafted) {
                const sent = content.emails_drafted.filter((e: any) => e.status === "sent").length;
                stats = `${content.emails_drafted.length} drafted, ${sent} sent`;
              } else if (r.report_type === "market_research" && content.tam) {
                stats = `TAM: ${content.tam.value || "N/A"}`;
              }

              return (
                <details key={r.id} style={{ background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                  <summary style={{ padding: "12px 14px", cursor: "pointer", fontSize: 13, color: "var(--hive-text-secondary)", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{icons[r.report_type] || "📄"}</span>
                    <span style={{ color: "var(--hive-text)", fontWeight: 500 }}>{labels[r.report_type] || r.report_type}</span>
                    {stats && <span style={{ fontSize: 12, color: "var(--hive-text-tertiary)" }}>— {stats}</span>}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>{timeAgo(r.updated_at)}</span>
                  </summary>
                  <div style={{ padding: "0 14px 14px" }}>
                    {r.summary && <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginBottom: 8 }}>{r.summary}</div>}
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, color: "var(--hive-text-tertiary)", maxHeight: 300, overflow: "auto",
                      padding: 10, background: "var(--hive-bg)", borderRadius: 6, fontFamily: "var(--hive-mono)" }}>
                      {JSON.stringify(content, null, 2).slice(0, 2000)}
                    </pre>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {/* Cycles */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: "0 0 12px", fontWeight: 500 }}>
          Cycles ({cycles.length})
        </h3>
        {cycles.length === 0 ? (
          <div style={{ padding: 20, color: "var(--hive-text-tertiary)", fontSize: 13, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>No cycles yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cycles.map(c => {
              let score: number | null = null;
              try {
                const review = typeof c.ceo_review === "string" ? JSON.parse(c.ceo_review) : c.ceo_review;
                score = review?.review?.score || review?.score || null;
              } catch {}
              const scoreColor = score !== null ? (score >= 7 ? "var(--hive-green)" : score >= 4 ? "var(--hive-amber)" : "var(--hive-red)") : "var(--hive-text-tertiary)";

              return (
                <details key={c.id} style={{ background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                  <summary style={{ padding: "12px 14px", cursor: "pointer", fontSize: 13, color: "var(--hive-text-secondary)", listStyle: "none" }}>
                    <span style={{ color: "var(--hive-text)", fontWeight: 500 }}>Cycle {c.cycle_number}</span>
                    <span style={{ marginLeft: 8, fontSize: 12, color: c.status === "completed" ? "var(--hive-green)" : c.status === "failed" ? "var(--hive-red)" : "var(--hive-text-tertiary)" }}>
                      {c.status}
                    </span>
                    {score !== null && (
                      <span style={{ marginLeft: 8, fontSize: 12, fontFamily: "var(--hive-mono)", color: scoreColor, fontWeight: 500 }}>{score}/10</span>
                    )}
                    <span style={{ float: "right", fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>{timeAgo(c.started_at)}</span>
                  </summary>
                  <div style={{ padding: "0 14px 14px", fontSize: 13, color: "var(--hive-text-secondary)" }}>
                    {c.ceo_plan && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ color: "var(--hive-amber)", fontSize: 12, fontFamily: "var(--hive-mono)", marginBottom: 4 }}>CEO Plan:</div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, color: "var(--hive-text-secondary)", maxHeight: 200, overflow: "auto",
                          fontFamily: "var(--hive-mono)" }}>
                          {typeof c.ceo_plan === "string" ? c.ceo_plan.slice(0, 500) : JSON.stringify(c.ceo_plan, null, 2).slice(0, 500)}
                        </pre>
                      </div>
                    )}
                    {c.ceo_review && (
                      <div>
                        <div style={{ color: "var(--hive-purple)", fontSize: 12, fontFamily: "var(--hive-mono)", marginBottom: 4 }}>CEO Review:</div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, color: "var(--hive-text-secondary)", maxHeight: 200, overflow: "auto",
                          fontFamily: "var(--hive-mono)" }}>
                          {typeof c.ceo_review === "string" ? c.ceo_review.slice(0, 500) : JSON.stringify(c.ceo_review, null, 2).slice(0, 500)}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent actions */}
      <div>
        <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: "0 0 12px", fontWeight: 500 }}>
          Agent activity ({actions.length})
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {actions.slice(0, 30).map(a => {
            const agent = AGENT_MAP[a.agent] || { label: a.agent.slice(0, 3).toUpperCase(), color: "#9d9da8" };
            const isFail = a.status === "failed";
            return (
              <div key={a.id} style={{
                padding: "10px 14px", background: isFail ? "var(--hive-red-bg)" : "var(--hive-surface)", borderRadius: 8,
                border: `1px solid ${isFail ? "var(--hive-red-border)" : "var(--hive-border)"}`,
                fontSize: 13, display: "flex", alignItems: "flex-start", gap: 10,
              }}>
                <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, letterSpacing: "0.06em",
                  padding: "2px 7px", borderRadius: 4, color: agent.color, background: agent.color + "14",
                  border: `1px solid ${agent.color}2a`, flexShrink: 0, marginTop: 1 }}>
                  {agent.label}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: isFail ? "var(--hive-red)" : "var(--hive-text-secondary)", lineHeight: 1.5 }}>{a.description.slice(0, 200)}</div>
                  {a.error && <div style={{ color: "var(--hive-red)", fontSize: 12, marginTop: 4, fontFamily: "var(--hive-mono)" }}>{a.error.slice(0, 150)}</div>}
                  {a.reflection && <div style={{ color: "var(--hive-purple)", fontSize: 12, marginTop: 4, fontStyle: "italic" }}>{a.reflection.slice(0, 150)}</div>}
                </div>
                <span style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", flexShrink: 0 }}>
                  {a.status === "failed" ? "✗" : a.status === "escalated" ? "!" : "✓"} {a.finished_at ? timeAgo(a.finished_at) : ""}
                </span>
              </div>
            );
          })}
          {actions.length === 0 && (
            <div style={{ padding: 20, color: "var(--hive-text-tertiary)", fontSize: 13, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>No activity yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
