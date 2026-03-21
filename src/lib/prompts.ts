import { readFileSync } from "fs";
import { join } from "path";

// Load prompt files at module init time (server-side only, works on Vercel)
// Fallback chain: DB prompt → file prompt → inline stub
const PROMPT_DIR = join(process.cwd(), "prompts");

function loadPromptFile(agent: string): string | null {
  try {
    return readFileSync(join(PROMPT_DIR, `${agent}.md`), "utf-8");
  } catch {
    return null;
  }
}

// Cache prompt files at module level (loaded once per cold start)
const FILE_PROMPTS: Record<string, string | null> = {
  growth: loadPromptFile("growth"),
  outreach: loadPromptFile("outreach"),
  ops: loadPromptFile("ops"),
  ceo: loadPromptFile("ceo"),
  engineer: loadPromptFile("engineer"),
  scout: loadPromptFile("scout"),
  evolver: loadPromptFile("evolver"),
  healer: loadPromptFile("healer"),
};

/**
 * Get the best available prompt for an agent.
 * Priority: DB prompt (from Prompt Evolver) → file prompt → inline fallback
 */
export function getFilePrompt(agent: string): string | null {
  return FILE_PROMPTS[agent] ?? null;
}
