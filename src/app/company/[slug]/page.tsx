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

const STATUS_COLORS: Record<string, string> = {
  idea: "#948264", approved: "#64a0c8", provisioning: "#c8aa50", mvp: "#78b48c",
  active: "#3cd296", paused: "#b48c64", killed: "#c85a50",
};
const AGENT_COLORS: Record<string, string> = {
  ceo: "#e8b84d", engineer: "#5ba8e8", growth: "#6dd490", ops: "#a88cdb",
  idea_scout: "#70c4e8", orchestrator: "#e8a050",
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
    // Get company by slug
    const cRes = await fetch("/api/companies");
    if (!cRes.ok) return;
    const allCompanies = (await cRes.json()).data;
    const comp = allCompanies.find((c: Company) => c.slug === slug);
    if (!comp) { setLoading(false); return; }
    setCompany(comp);

    // Fetch all data for this company
    const [cyRes, acRes, meRes, apRes, reRes] = await Promise.all([
      fetch(`/api/cycles?company_id=${comp.id}&limit=20`),
      fetch(`/api/actions?company_id=${comp.id}&limit=50`),
      fetch(`/api/metrics?company_id=${comp.id}`),
      fetch(`/api/approvals?company_id=${comp.id}&status=all`),
      fetch(`/api/research?company_id=${comp.id}`),
    ]);
    if (cyRes.ok) setCycles((await cyRes.json()).data || []);
    if (acRes.ok) setActions((await acRes.json()).data || []);
    if (meRes.ok) setMetrics((await meRes.json()).data || []);
    if (apRes.ok) setApprovals((await apRes.json()).data || []);
    if (reRes.ok) setResearch((await reRes.json()).data || []);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
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

  if (loading) return <div style={{ padding: 40, color: "#888" }}>Loading...</div>;
  if (!company) return <div style={{ padding: 40, color: "#e85050" }}>Company "{slug}" not found</div>;

  const statusColor = STATUS_COLORS[company.status] || "#888";
  const pendingApprovals = approvals.filter(a => a.status === "pending");
  const latestMetrics = metrics.slice(0, 10);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#c8c8c0" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link href="/" style={{ color: "#888", fontSize: 13, textDecoration: "none" }}>← Dashboard</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 500, color: "#f0f0ec", margin: 0 }}>{company.name}</h1>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", padding: "2px 8px", borderRadius: 3,
            color: statusColor, background: statusColor + "1a", border: `1px solid ${statusColor}33` }}>
            {company.status.toUpperCase()}
          </span>
        </div>
        <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>{company.description}</div>
        <div style={{ fontSize: 12, color: "#666", marginTop: 4, display: "flex", gap: 16 }}>
          {company.vercel_url && <a href={company.vercel_url} target="_blank" rel="noreferrer" style={{ color: "#e8b84d", textDecoration: "none" }}>{company.vercel_url}</a>}
          <span>Created {timeAgo(company.created_at)}</span>
          {company.killed_at && <span style={{ color: "#e85050" }}>Killed {timeAgo(company.killed_at)}: {company.kill_reason}</span>}
        </div>
      </div>

      {/* Directive input */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={directive} onChange={e => setDirective(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") sendDirective(); }}
            placeholder={`Send directive to ${company.name}...`}
            style={{ flex: 1, padding: "8px 12px", background: "#111", border: "1px solid #333", borderRadius: 6,
              color: "#f0f0ec", fontSize: 13, outline: "none" }}
          />
          <button onClick={sendDirective} disabled={sending || !directive.trim()}
            style={{ padding: "8px 16px", background: sending ? "#333" : "#e8b84d20", border: "1px solid #e8b84d33",
              borderRadius: 6, color: "#e8b84d", fontSize: 13, cursor: "pointer" }}>
            Send
          </button>
        </div>
      </div>

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div style={{ marginBottom: 24, padding: 16, background: "#e8b84d08", border: "1px solid #e8b84d22", borderRadius: 8 }}>
          <h3 style={{ fontSize: 14, color: "#e8b84d", margin: "0 0 12px", fontWeight: 500 }}>
            {pendingApprovals.length} pending approval{pendingApprovals.length > 1 ? "s" : ""}
          </h3>
          {pendingApprovals.map(a => (
            <div key={a.id} style={{ marginBottom: 12, padding: 12, background: "#0a0a09", borderRadius: 6, border: "1px solid #222" }}>
              <div style={{ fontSize: 13, color: "#f0f0ec", marginBottom: 4 }}>
                <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "#534AB720", color: "#b090d0", marginRight: 8 }}>{a.gate_type}</span>
                {a.title}
              </div>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8, whiteSpace: "pre-wrap" }}>{a.description.slice(0, 300)}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => handleApproval(a.id, "approved")}
                  style={{ padding: "4px 12px", background: "#1D9E7520", border: "1px solid #1D9E7533", borderRadius: 4, color: "#5DCAA5", fontSize: 12, cursor: "pointer" }}>
                  Approve
                </button>
                <button onClick={() => handleApproval(a.id, "rejected")}
                  style={{ padding: "4px 12px", background: "#E24B4A20", border: "1px solid #E24B4A33", borderRadius: 4, color: "#F09595", fontSize: 12, cursor: "pointer" }}>
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
          <h3 style={{ fontSize: 14, color: "#f0f0ec", margin: "0 0 12px", fontWeight: 500 }}>Latest metrics</h3>
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
                  <div key={i} style={{ padding: "10px 12px", background: "#111", borderRadius: 6, border: "1px solid #222" }}>
                    <div style={{ fontSize: 18, fontWeight: 500, color: m.highlight ? "#5DCAA5" : "#f0f0ec" }}>{m.value}</div>
                    <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{m.label}</div>
                    <div style={{ fontSize: 10, color: "#555" }}>{latest.date}</div>
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
          <h3 style={{ fontSize: 14, color: "#f0f0ec", margin: "0 0 12px", fontWeight: 500 }}>Research intelligence</h3>
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

              // Quick stats per report type
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
                <details key={r.id} style={{ background: "#111", borderRadius: 6, border: "1px solid #222" }}>
                  <summary style={{ padding: "10px 12px", cursor: "pointer", fontSize: 13, color: "#c8c8c0", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{icons[r.report_type] || "📄"}</span>
                    <span style={{ color: "#f0f0ec", fontWeight: 500 }}>{labels[r.report_type] || r.report_type}</span>
                    {stats && <span style={{ fontSize: 11, color: "#888" }}>— {stats}</span>}
                    <span style={{ marginLeft: "auto", fontSize: 10, color: "#555" }}>{timeAgo(r.updated_at)}</span>
                  </summary>
                  <div style={{ padding: "0 12px 12px" }}>
                    {r.summary && <div style={{ fontSize: 12, color: "#aaa", marginBottom: 8 }}>{r.summary}</div>}
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "#888", maxHeight: 300, overflow: "auto",
                      padding: 8, background: "#0a0a09", borderRadius: 4 }}>
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
        <h3 style={{ fontSize: 14, color: "#f0f0ec", margin: "0 0 12px", fontWeight: 500 }}>
          Cycles ({cycles.length})
        </h3>
        {cycles.length === 0 ? (
          <div style={{ padding: 16, color: "#666", fontSize: 13, background: "#111", borderRadius: 8, border: "1px solid #222" }}>No cycles yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cycles.map(c => {
              let score: number | null = null;
              try {
                const review = typeof c.ceo_review === "string" ? JSON.parse(c.ceo_review) : c.ceo_review;
                score = review?.review?.score || review?.score || null;
              } catch {}
              const scoreColor = score !== null ? (score >= 7 ? "#5DCAA5" : score >= 4 ? "#e8b84d" : "#e85050") : "#666";

              return (
                <details key={c.id} style={{ background: "#111", borderRadius: 6, border: "1px solid #222" }}>
                  <summary style={{ padding: "10px 12px", cursor: "pointer", fontSize: 13, color: "#c8c8c0", listStyle: "none" }}>
                    <span style={{ color: "#f0f0ec", fontWeight: 500 }}>Cycle {c.cycle_number}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: c.status === "completed" ? "#5DCAA5" : c.status === "failed" ? "#e85050" : "#888" }}>
                      {c.status}
                    </span>
                    {score !== null && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: scoreColor, fontWeight: 500 }}>{score}/10</span>
                    )}
                    <span style={{ float: "right", fontSize: 11, color: "#666" }}>{timeAgo(c.started_at)}</span>
                  </summary>
                  <div style={{ padding: "0 12px 12px", fontSize: 12, color: "#999" }}>
                    {c.ceo_plan && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: "#e8b84d", fontSize: 11, marginBottom: 4 }}>CEO Plan:</div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "#aaa", maxHeight: 200, overflow: "auto" }}>
                          {typeof c.ceo_plan === "string" ? c.ceo_plan.slice(0, 500) : JSON.stringify(c.ceo_plan, null, 2).slice(0, 500)}
                        </pre>
                      </div>
                    )}
                    {c.ceo_review && (
                      <div>
                        <div style={{ color: "#a88cdb", fontSize: 11, marginBottom: 4 }}>CEO Review:</div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "#aaa", maxHeight: 200, overflow: "auto" }}>
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
        <h3 style={{ fontSize: 14, color: "#f0f0ec", margin: "0 0 12px", fontWeight: 500 }}>
          Agent activity ({actions.length})
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {actions.slice(0, 30).map(a => {
            const color = AGENT_COLORS[a.agent] || "#888";
            return (
              <div key={a.id} style={{ padding: "8px 12px", background: "#111", borderRadius: 6, border: "1px solid #222",
                fontSize: 12, display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", padding: "2px 6px", borderRadius: 3,
                  color, background: color + "18", border: `1px solid ${color}33`, flexShrink: 0, marginTop: 1 }}>
                  {a.agent.slice(0, 3).toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#c8c8c0" }}>{a.description.slice(0, 200)}</div>
                  {a.error && <div style={{ color: "#e85050", fontSize: 11, marginTop: 2 }}>{a.error.slice(0, 150)}</div>}
                  {a.reflection && <div style={{ color: "#b090d0", fontSize: 11, marginTop: 2, fontStyle: "italic" }}>{a.reflection.slice(0, 150)}</div>}
                </div>
                <span style={{ fontSize: 10, color: "#555", flexShrink: 0 }}>
                  {a.status === "failed" ? "✗" : a.status === "escalated" ? "!" : "✓"} {a.finished_at ? timeAgo(a.finished_at) : ""}
                </span>
              </div>
            );
          })}
          {actions.length === 0 && (
            <div style={{ padding: 16, color: "#666", fontSize: 13, background: "#111", borderRadius: 8, border: "1px solid #222" }}>No activity yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
