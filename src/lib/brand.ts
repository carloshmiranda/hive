import { z } from "zod";
import { generateStructured } from "@/lib/llm";

export const BrandSchema = z.object({
  tagline: z.string().describe("Short punchy tagline (max 8 words)"),
  tone: z.string().describe("Brand tone in 2-3 words (e.g. 'professional yet approachable', 'bold and direct')"),
  personality: z.string().describe("Brand personality description in 1-2 sentences"),
  voice: z.string().describe("How the brand speaks: formal/casual/technical/conversational"),
  colors: z.object({
    primary: z.string().describe("Primary brand color as hex code (e.g. #2563EB)"),
    secondary: z.string().describe("Secondary brand color as hex code"),
    accent: z.string().describe("Accent/highlight color as hex code"),
  }),
});

export type Brand = z.infer<typeof BrandSchema>;

export async function generateBrand(sql: any, companyId: string): Promise<Brand> {
  const [company] = await sql`
    SELECT id, name, slug, description, company_type, market, content_language
    FROM companies
    WHERE id = ${companyId}
    LIMIT 1
  `;

  if (!company) throw new Error(`Company not found: ${companyId}`);

  const market = company.market === "portugal" ? "Portuguese" : "global";
  const lang = company.content_language === "pt" ? "Portuguese" : "English";

  const prompt = {
    system: `You are a brand strategist creating distinctive brand identities for startups.
Generate cohesive, memorable brand identities that feel authentic — not generic.
Avoid clichés like "empowering", "revolutionary", or "seamless".
Colors should be distinctive and work well together as a palette.`,
    user: `Create a brand identity for this startup:

Company name: ${company.name}
Type: ${company.company_type}
Market: ${market}
Content language: ${lang}
Description: ${company.description || "No description provided"}

Generate a cohesive brand identity. The tagline should be in ${lang}.
Colors should suit the company type (e.g. fintech = trustworthy blues, health = calm greens, creative = vibrant accents).`,
  };

  const brand = await generateStructured<Brand>("ops", prompt, BrandSchema);

  await sql`
    UPDATE companies
    SET brand = ${JSON.stringify(brand)}::jsonb,
        updated_at = NOW()
    WHERE id = ${company.id}
  `;

  return brand;
}
