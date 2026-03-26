export const AGENT_DISPLAY: Record<string, { name: string; icon: string; description: string }> = {
  ceo: { name: "CEO", icon: "🎩", description: "Strategic planning & company evaluation" },
  engineer: { name: "Engineer", icon: "⚙️", description: "Code implementation & infrastructure" },
  scout: { name: "Scout", icon: "🔭", description: "Market research & idea generation" },
  evolver: { name: "Evolver", icon: "🧬", description: "Prompt & process optimization" },
  growth: { name: "Growth", icon: "📈", description: "SEO, content & audience building" },
  outreach: { name: "Outreach", icon: "📧", description: "Lead generation & cold email" },
  ops: { name: "Ops", icon: "🔧", description: "Health checks & error detection" },
  sentinel: { name: "Sentinel", icon: "👁️", description: "Scheduled monitoring & dispatch" },
  healer: { name: "Healer", icon: "🏥", description: "Auto-fix recurring failures" },
  backlog: { name: "Backlog", icon: "📋", description: "Task planning & dispatch chain" },
};

export const ACTION_DISPLAY: Record<string, string> = {
  cycle_start: "Start Cycle",
  cycle_complete: "Cycle Complete",
  feature_request: "Build Feature",
  gate_approved: "Gate Approved",
  research_request: "Research",
  evolve_trigger: "Optimize Prompts",
  healer_trigger: "Auto-Heal",
  pipeline_low: "Expand Pipeline",
  company_killed: "Company Killed",
};

export function getAgentDisplay(agent: string) { return AGENT_DISPLAY[agent] || { name: agent, icon: "🤖", description: agent }; }
export function getActionDisplay(action: string) { return ACTION_DISPLAY[action] || action.replace(/_/g, " "); }