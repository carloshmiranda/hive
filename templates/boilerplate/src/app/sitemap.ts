import { MetadataRoute } from "next";

// Dynamic sitemap — add new pages here as they're created
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://{{SLUG}}.vercel.app";

  return [
    {
      url: baseUrl,
      lastModified: "{{LAUNCH_DATE}}",
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
