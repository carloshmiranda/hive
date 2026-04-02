"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Company = {
  id: string; name: string; slug: string; description: string; status: string;
  vercel_url: string | null; created_at: string; killed_at: string | null; kill_reason: string | null;
  capabilities: Record<string, any> | null; company_type: string | null; imported: boolean;
  last_assessed_at: string | null;
};
type Cycle = {
  id: string; cycle_number: number; status: string; ceo_plan: any; ceo_review: any;
  started_at: string; finished_at: string | null;
};
type Action = {
  id: string; agent: string; action_type: string; description: string; status: string;
  error: string | null; reflection: string | null; tokens_used: number; finished_at: string;
  output: Record<string, unknown> | null;
};
type Metric = {
  date: string; revenue: number; mrr: number; customers: number;
  page_views: number; signups: number; churn_rate: number;
};
type Approval = {
  id: string; gate_type: string; title: string; description: string; status: string; created_at: string;
};
type Task = {
  id: string; category: string; title: string; description: string; priority: number;
  status: string; source: string; prerequisites: string[]; acceptance: string | null; created_at: string;
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [directive, setDirective] = useState("");
  const [sending, setSending] = useState(false);
  const directiveInputRef = useRef<HTMLInputElement>(null);
  const [directiveSent, setDirectiveSent] = useState<string | null>(null);
  const [taskCategoryFilter, setTaskCategoryFilter] = useState("all");
  const [unitEcon, setUnitEcon] = useState<{
    ltv: number | null; cac: number | null; ltv_cac_ratio: number | null;
    arpu: number | null; monthly_churn: number | null; avg_customer_lifespan_months: number | null;
    total_ad_spend: number; total_revenue: number; total_customers: number;
    cohorts: Array<{ month: string; customers_acquired: number; cumulative_revenue: number; avg_revenue_per_customer: number }>;
    health: string; health_reason: string; kill_signal: boolean; kill_reason: string | null;
  } | null>(null);

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
    setTasks(data.tasks || []);
    setLoading(false);
    // Fetch unit economics separately
    fetch(`/api/metrics/unit-economics?slug=${slug}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.data) setUnitEcon(d.data); })
      .catch(() => {});
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
    const res = await fetch("/api/directives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: company.id, text: directive }),
    });
    const data = await res.json();
    setDirective("");
    setSending(false);
    const issueUrl = data?.data?.github_issue?.url;
    setDirectiveSent(issueUrl || "sent");
    setTimeout(() => setDirectiveSent(null), 4000);
    fetchData();
  };

  const handleApproval = async (id: string, decision: "approved" | "rejected") => {
    if (decision === "rejected" && !confirm("Reject this approval?")) return;
    await fetch(`/api/approvals/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    fetchData();
  };

  // Memoized derivations — must be before conditional returns (Rules of Hooks)
  const pendingApprovals = useMemo(() => approvals.filter(a => a.status === "pending"), [approvals]);
  const latestMetrics = useMemo(() => metrics.slice(0, 10), [metrics]);
  const taskCategories = useMemo(
    () => ["all", ...Array.from(new Set(tasks.map(t => t.category))).sort()],
    [tasks]
  );

  if (loading) return <div style={{ padding: 40, fontFamily: "var(--hive-sans)", color: "var(--hive-text-secondary)", fontSize: 13 }}>Loading...</div>;
  if (!company) return <div style={{ padding: 40, fontFamily: "var(--hive-sans)", color: "var(--hive-red)", fontSize: 13 }}>Company &quot;{slug}&quot; not found</div>;

  const status = STATUS_MAP[company.status] || STATUS_MAP.idea;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px", fontFamily: "var(--hive-sans)", color: "var(--hive-text)", background: "var(--hive-bg)", minHeight: "100dvh" }}>

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
          <input ref={directiveInputRef} value={directive} onChange={e => setDirective(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") sendDirective(); }}
            aria-label={`Send directive to ${company.name}`}
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
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
        {directiveSent && (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--hive-green)", fontFamily: "var(--hive-mono)" }}>
            ✓ Directive sent
            {directiveSent !== "sent" && <> — <a href={directiveSent} target="_blank" rel="noreferrer" style={{ color: "var(--hive-green)" }}>view issue</a></>}
          </div>
        )}
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
              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginBottom: 10, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{(a.description || '').slice(0, 300)}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => handleApproval(a.id, "approved")}
                  aria-label={`Approve: ${a.title}`}
                  style={{ padding: "6px 16px", background: "var(--hive-green-bg)", border: "1px solid var(--hive-green-border)",
                    borderRadius: 6, color: "var(--hive-green)", fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, cursor: "pointer" }}>
                  Approve
                </button>
                <button onClick={() => handleApproval(a.id, "rejected")}
                  aria-label={`Reject: ${a.title}`}
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
                    <div style={{ fontSize: 18, fontWeight: 600, fontFamily: "var(--hive-mono)", fontVariantNumeric: "tabular-nums", color: m.highlight ? "var(--hive-green)" : "var(--hive-text)" }}>{m.value}</div>
                    <div style={{ fontSize: 12, color: "var(--hive-text-secondary)", marginTop: 2 }}>{m.label}</div>
                    <div style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>{latest.date}</div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Unit Economics */}
      {unitEcon && unitEcon.health !== 'insufficient_data' && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: "0 0 12px", fontWeight: 500 }}>Unit Economics</h3>
          {/* Health badge */}
          <div style={{ marginBottom: 12, padding: "8px 14px", borderRadius: 8,
            background: unitEcon.health === 'excellent' ? "var(--hive-green-bg)" : unitEcon.health === 'good' ? "var(--hive-green-bg)" : unitEcon.health === 'warning' ? "var(--hive-amber-bg)" : "var(--hive-red-bg)",
            border: `1px solid ${unitEcon.health === 'excellent' || unitEcon.health === 'good' ? "var(--hive-green-border)" : unitEcon.health === 'warning' ? "var(--hive-amber-border)" : "var(--hive-red-border)"}`,
          }}>
            <span style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500,
              color: unitEcon.health === 'excellent' || unitEcon.health === 'good' ? "var(--hive-green)" : unitEcon.health === 'warning' ? "var(--hive-amber)" : "var(--hive-red)",
            }}>{unitEcon.health.toUpperCase()}</span>
            <span style={{ fontSize: 12, color: "var(--hive-text-secondary)", marginLeft: 8 }}>{unitEcon.health_reason}</span>
          </div>
          {/* Kill signal */}
          {unitEcon.kill_signal && unitEcon.kill_reason && (
            <div style={{ marginBottom: 12, padding: "8px 14px", borderRadius: 8, background: "var(--hive-red-bg)", border: "1px solid var(--hive-red-border)" }}>
              <span style={{ fontSize: 12, fontFamily: "var(--hive-mono)", fontWeight: 500, color: "var(--hive-red)" }}>KILL SIGNAL</span>
              <span style={{ fontSize: 12, color: "var(--hive-text-secondary)", marginLeft: 8 }}>{unitEcon.kill_reason}</span>
            </div>
          )}
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 8 }}>
            {[
              { label: "LTV", value: unitEcon.ltv !== null ? `€${unitEcon.ltv.toFixed(0)}` : "—", highlight: (unitEcon.ltv || 0) > 0 },
              { label: "CAC", value: unitEcon.cac !== null ? `€${unitEcon.cac.toFixed(0)}` : "—", highlight: false },
              { label: "LTV/CAC", value: unitEcon.ltv_cac_ratio !== null ? `${unitEcon.ltv_cac_ratio.toFixed(1)}x` : "—",
                highlight: (unitEcon.ltv_cac_ratio || 0) >= 3 },
              { label: "ARPU/mo", value: unitEcon.arpu !== null ? `€${unitEcon.arpu.toFixed(2)}` : "—", highlight: (unitEcon.arpu || 0) > 0 },
              { label: "Churn/mo", value: unitEcon.monthly_churn !== null ? `${(unitEcon.monthly_churn * 100).toFixed(1)}%` : "—", highlight: false },
              { label: "Avg lifespan", value: unitEcon.avg_customer_lifespan_months !== null ? `${unitEcon.avg_customer_lifespan_months}mo` : "—", highlight: false },
              { label: "Ad spend", value: `€${unitEcon.total_ad_spend.toFixed(0)}`, highlight: false },
            ].map((m, i) => (
              <div key={i} style={{ padding: "12px 14px", background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                <div style={{ fontSize: 18, fontWeight: 600, fontFamily: "var(--hive-mono)", fontVariantNumeric: "tabular-nums", color: m.highlight ? "var(--hive-green)" : "var(--hive-text)" }}>{m.value}</div>
                <div style={{ fontSize: 12, color: "var(--hive-text-secondary)", marginTop: 2 }}>{m.label}</div>
              </div>
            ))}
          </div>
          {/* Cohort table */}
          {unitEcon.cohorts.length > 0 && (
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--hive-mono)" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--hive-border)" }}>
                    {["Month", "New customers", "Cum. revenue", "Rev/customer"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "var(--hive-text-secondary)", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {unitEcon.cohorts.slice(-6).map(c => (
                    <tr key={c.month} style={{ borderBottom: "1px solid var(--hive-border)" }}>
                      <td style={{ padding: "6px 10px", color: "var(--hive-text)" }}>{c.month}</td>
                      <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums", color: "var(--hive-text)" }}>{c.customers_acquired}</td>
                      <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums", color: "var(--hive-text)" }}>€{c.cumulative_revenue.toFixed(0)}</td>
                      <td style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums", color: c.avg_revenue_per_customer > 0 ? "var(--hive-green)" : "var(--hive-text-dim)" }}>€{c.avg_revenue_per_customer.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Latest CEO Briefing */}
      {(() => {
        const briefingAction = actions.find(a => a.agent === "ceo" && (a.action_type === "ceo_briefing" || a.action_type === "execute_task") && a.status === "success" && a.output);
        if (!briefingAction) return null;
        const raw = briefingAction.output;
        const o = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
        if (!o) return null;
        const review = o.review || o;
        const briefing = review.briefing || review;
        const whatIDid = briefing.what_i_did as string[] | undefined;
        const findings = (briefing.key_findings || {}) as Record<string, string>;
        const maturity = (briefing.product_maturity || {}) as Record<string, string[]>;
        const planTomorrow = briefing.plan_tomorrow as string | undefined;
        const score = review.score as number | undefined;
        const scoreColor = score != null ? (score >= 7 ? "var(--hive-green)" : score >= 4 ? "var(--hive-amber)" : "var(--hive-red)") : undefined;

        return (
          <div style={{ marginBottom: 24, padding: 20, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: 0, fontWeight: 500 }}>Latest CEO Briefing</h3>
              {score != null && <span style={{ fontSize: 13, fontFamily: "var(--hive-mono)", fontWeight: 600, color: scoreColor }}>{score}/10</span>}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                {briefingAction.finished_at ? timeAgo(briefingAction.finished_at) : ""}
              </span>
            </div>
            {whatIDid && whatIDid.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", marginBottom: 4 }}>Actions</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.6 }}>
                  {whatIDid.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              </div>
            )}
            {(findings.product_state || findings.critical_gap || findings.opportunity) && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", marginBottom: 4 }}>Findings</div>
                {findings.product_state && <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", marginBottom: 4 }}>{findings.product_state}</div>}
                {findings.critical_gap && <div style={{ fontSize: 13, color: "var(--hive-red)", marginBottom: 4 }}>Gap: {findings.critical_gap}</div>}
                {findings.opportunity && <div style={{ fontSize: 13, color: "var(--hive-green)", marginBottom: 4 }}>Opportunity: {findings.opportunity}</div>}
              </div>
            )}
            {maturity.done && maturity.done.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", marginBottom: 4 }}>Product maturity</div>
                <div style={{ fontSize: 13, color: "var(--hive-text-secondary)" }}>
                  <span style={{ color: "var(--hive-green)" }}>Done:</span> {maturity.done.join(", ")}
                  {maturity.building && maturity.building.length > 0 && <> · <span style={{ color: "var(--hive-amber)" }}>Building:</span> {maturity.building.join(", ")}</>}
                  {maturity.planned && maturity.planned.length > 0 && <> · <span style={{ color: "var(--hive-text-tertiary)" }}>Planned:</span> {maturity.planned.join(", ")}</>}
                </div>
              </div>
            )}
            {planTomorrow && (
              <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", padding: "8px 0 0", borderTop: "1px solid var(--hive-border)" }}>
                <span style={{ fontFamily: "var(--hive-mono)", fontSize: 12, color: "var(--hive-text-tertiary)" }}>Next: </span>{planTomorrow}
              </div>
            )}
          </div>
        );
      })()}

      {/* Capabilities */}
      {company && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: 0, fontWeight: 500 }}>Capabilities</h3>
            {company.last_assessed_at && (
              <span style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)" }}>
                assessed {timeAgo(company.last_assessed_at)}
              </span>
            )}
            <button
              onClick={async () => {
                const res = await fetch(`/api/companies/${company?.id || slug}/assess`, { method: "POST" });
                if (res.ok) fetchData();
              }}
              style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 11, fontFamily: "var(--hive-mono)",
                background: "var(--hive-surface)", border: "1px solid var(--hive-border)", borderRadius: 6,
                color: "var(--hive-text-secondary)", cursor: "pointer" }}>
              Re-assess
            </button>
          </div>
          {(() => {
            const caps = company.capabilities || {};
            const capGroups: Record<string, string[]> = {
              "Infra": ["database", "hosting", "repo"],
              "Payment": ["stripe", "auth"],
              "Email": ["email_provider", "email_sequences", "email_log", "resend_webhook"],
              "Growth": ["waitlist", "referral_mechanics", "gsc_integration", "visibility_metrics"],
              "SEO": ["indexnow", "llms_txt", "sitemap", "json_ld"],
            };
            if (Object.keys(caps).length === 0) {
              return (
                <div style={{ padding: 16, background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)",
                  fontSize: 13, color: "var(--hive-text-tertiary)" }}>
                  No capabilities assessed yet. Click &quot;Re-assess&quot; to scan.
                </div>
              );
            }
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                {Object.entries(capGroups).map(([group, keys]) => (
                  <div key={group} style={{ padding: "10px 12px", background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                    <div style={{ fontSize: 11, color: "var(--hive-text-tertiary)", fontFamily: "var(--hive-mono)", letterSpacing: "0.04em", marginBottom: 6 }}>{group}</div>
                    {keys.map(key => {
                      const cap = caps[key] as Record<string, any> | undefined;
                      const exists = cap?.exists === true;
                      const configured = cap?.configured;
                      const makesSense = cap?.makes_sense;
                      const dotColor = makesSense === false ? "var(--hive-text-dim)" :
                                      exists && configured === true ? "var(--hive-green)" :
                                      exists && configured === false ? "var(--hive-amber)" :
                                      exists ? "var(--hive-green)" : "var(--hive-text-dim)";
                      return (
                        <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}
                          title={makesSense === false ? `N/A: ${cap?.reason || "not applicable"}` :
                                configured === false ? "Exists but not configured" :
                                exists ? "Active" : "Not present"}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, flexShrink: 0,
                            textDecoration: makesSense === false ? "line-through" : "none" }} />
                          <span style={{ fontSize: 12, color: makesSense === false ? "var(--hive-text-dim)" : "var(--hive-text-secondary)",
                            textDecoration: makesSense === false ? "line-through" : "none" }}>
                            {key.replace(/_/g, " ")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Task Backlog */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, color: "var(--hive-text)", margin: 0, fontWeight: 500 }}>
            Tasks ({tasks.length})
          </h3>
          {tasks.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              {taskCategories.map(cat => (
                <button key={cat} onClick={() => setTaskCategoryFilter(cat)}
                  aria-pressed={taskCategoryFilter === cat}
                  style={{ fontSize: 11, fontFamily: "var(--hive-mono)", padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                    border: `1px solid ${taskCategoryFilter === cat ? "var(--hive-amber-border)" : "var(--hive-border-subtle, var(--hive-border))"}`,
                    background: taskCategoryFilter === cat ? "var(--hive-amber-bg)" : "transparent",
                    color: taskCategoryFilter === cat ? "var(--hive-amber)" : "var(--hive-text-secondary)" }}>
                  {cat === "all" ? "All" : cat}
                </button>
              ))}
            </div>
          )}
        </div>
        {tasks.length === 0 ? (
          <div style={{ padding: 20, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "var(--hive-text-tertiary)", fontSize: 13 }}>No tasks yet — CEO will propose tasks on next cycle</span>
            <button onClick={() => directiveInputRef.current?.focus()} style={{ padding: "6px 14px", fontSize: 12, fontFamily: "var(--hive-mono)", borderRadius: 6, border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-text-secondary)", cursor: "pointer" }}>Send directive</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tasks.filter(t => taskCategoryFilter === "all" || t.category === taskCategoryFilter).map(t => {
              const catColors: Record<string, string> = {
                engineering: "var(--hive-green)", growth: "var(--hive-purple)", research: "var(--hive-blue, #60a5fa)",
                qa: "var(--hive-amber)", ops: "var(--hive-pink, #f472b6)", strategy: "#38bdf8",
              };
              const prioLabels = ["P0", "P1", "P2", "P3"];
              const prioColors = ["var(--hive-red)", "var(--hive-amber)", "var(--hive-text-secondary)", "var(--hive-text-dim)"];
              const catColor = catColors[t.category] || "var(--hive-text-secondary)";
              const statusColors: Record<string, string> = {
                proposed: "var(--hive-text-tertiary)", approved: "var(--hive-blue, #60a5fa)",
                in_progress: "var(--hive-amber)",
              };

              return (
                <div key={t.id} style={{ padding: "12px 14px", background: "var(--hive-surface)", borderRadius: 8, border: "1px solid var(--hive-border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 500, padding: "1px 6px", borderRadius: 4,
                      color: catColor, background: catColor + "14", border: `1px solid ${catColor}2a` }}>
                      {t.category}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", fontWeight: 600, color: prioColors[t.priority] || prioColors[2] }}>
                      {prioLabels[t.priority] || "P2"}
                    </span>
                    <span style={{ fontSize: 13, color: "var(--hive-text)", fontWeight: 500, flex: 1 }}>{t.title}</span>
                    <span style={{ fontSize: 11, fontFamily: "var(--hive-mono)", color: statusColors[t.status] || "var(--hive-text-dim)" }}>
                      {t.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--hive-text-secondary)", lineHeight: 1.5, marginBottom: 6 }}>
                    {(t.description || '').slice(0, 200)}{(t.description || '').length > 200 ? "..." : ""}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {t.status === "proposed" && (
                      <>
                        <button onClick={async () => {
                          await fetch(`/api/tasks/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: Math.max(0, t.priority - 1) }) });
                          fetchData();
                        }} style={{ padding: "4px 12px", fontSize: 11, fontFamily: "var(--hive-mono)", background: "var(--hive-green-bg)",
                          border: "1px solid var(--hive-green-border)", borderRadius: 6, color: "var(--hive-green)", cursor: "pointer" }}>
                          Prioritize
                        </button>
                        <button onClick={async () => {
                          if (!confirm("Dismiss this task?")) return;
                          await fetch(`/api/tasks/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "dismissed" }) });
                          fetchData();
                        }} style={{ padding: "4px 12px", fontSize: 11, fontFamily: "var(--hive-mono)", background: "var(--hive-surface)",
                          border: "1px solid var(--hive-border)", borderRadius: 6, color: "var(--hive-text-dim)", cursor: "pointer" }}>
                          Dismiss
                        </button>
                      </>
                    )}
                    {t.prerequisites && t.prerequisites.length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", marginLeft: "auto" }}>
                        prereq: {t.prerequisites.join(", ")}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: "var(--hive-text-dim)", fontFamily: "var(--hive-mono)", marginLeft: t.prerequisites?.length ? 0 : "auto" }}>
                      {t.source} · {timeAgo(t.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
          <div style={{ padding: 20, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "var(--hive-text-tertiary)", fontSize: 13 }}>No cycles yet</span>
            <button onClick={() => directiveInputRef.current?.focus()} style={{ padding: "6px 14px", fontSize: 12, fontFamily: "var(--hive-mono)", borderRadius: 6, border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-text-secondary)", cursor: "pointer" }}>Trigger cycle</button>
          </div>
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
                  <div style={{ color: isFail ? "var(--hive-red)" : "var(--hive-text-secondary)", lineHeight: 1.5 }}>{(a.description || '').slice(0, 200)}</div>
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
            <div style={{ padding: 20, background: "var(--hive-surface)", borderRadius: 10, border: "1px solid var(--hive-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "var(--hive-text-tertiary)", fontSize: 13 }}>No activity yet</span>
              <button onClick={() => directiveInputRef.current?.focus()} style={{ padding: "6px 14px", fontSize: 12, fontFamily: "var(--hive-mono)", borderRadius: 6, border: "1px solid var(--hive-border)", background: "transparent", color: "var(--hive-text-secondary)", cursor: "pointer" }}>Send directive</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
