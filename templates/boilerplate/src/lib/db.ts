import { neon, neonConfig } from "@neondatabase/serverless";

// Enable connection caching for better serverless performance
neonConfig.fetchConnectionCache = true;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  // Verify pooled connection (should contain -pooler in hostname)
  if (!url.includes("-pooler")) {
    console.warn("⚠️  DATABASE_URL appears to use direct connection. For serverless, use pooled endpoint ending with -pooler.{region}.aws.neon.tech");
  }

  return neon(url);
}
