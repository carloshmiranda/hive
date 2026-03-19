import { getSettingValue } from "./settings";

// DIY LLM citation tracker — uses Gemini free tier to check if a company
// is cited when someone asks an LLM about the problem space.
// €0 cost, runs every 3 cycles per company.

interface CitationResult {
  keyword: string;
  prompt: string;
  cited: boolean;
  mentioned: boolean;
  competitors: string[];
  sources: string[];
  response_snippet: string;
}

const NOISE_WORDS = new Set([
  "The", "This", "That", "Here", "What", "Best", "Top", "Some", "Each",
  "They", "With", "From", "Into", "Also", "Both", "Many", "Most", "Very",
  "Well", "Good", "Your", "Their", "These", "Those", "More", "Other",
  "Such", "First", "Last", "Next", "Just", "Like", "Over", "Even",
]);

export async function checkLLMCitations(
  companyName: string,
  companyUrl: string,
  keywords: string[],
): Promise<CitationResult[]> {
  const apiKey = await getSettingValue("gemini_api_key");
  if (!apiKey) return [];

  const results: CitationResult[] = [];

  for (const keyword of keywords.slice(0, 10)) {
    const prompt = `What are the best ${keyword} tools or services available? List the top options with brief descriptions of each.`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
          }),
        }
      );

      if (!res.ok) continue;

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      const lowerText = text.toLowerCase();
      const lowerName = companyName.toLowerCase();
      const domain = new URL(companyUrl).hostname.replace("www.", "");

      // Find possible brand names (capitalized words)
      const brandPattern = /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\b/g;
      const possibleBrands: string[] = [...new Set<string>(
        (text.match(brandPattern) || [])
          .filter((b: string) => b.toLowerCase() !== lowerName && b.length > 2 && !NOISE_WORDS.has(b))
      )];

      // Find URLs in the response
      const urlPattern = /https?:\/\/[^\s),]+/g;
      const urls = text.match(urlPattern) || [];

      results.push({
        keyword,
        prompt,
        cited: urls.some((u: string) => u.includes(domain)),
        mentioned: lowerText.includes(lowerName),
        competitors: possibleBrands.slice(0, 10),
        sources: urls.slice(0, 10),
        response_snippet: text.slice(0, 500),
      });

      // Rate limiting: stay within free tier
      await new Promise(r => setTimeout(r, 2000));
    } catch {
      continue;
    }
  }

  return results;
}
