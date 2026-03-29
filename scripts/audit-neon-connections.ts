#!/usr/bin/env tsx
/**
 * Audit script to verify all database connections use Neon pooled endpoints
 *
 * This script:
 * 1. Checks DATABASE_URL environment variable for pooled endpoint
 * 2. Audits connection strings stored in infra table
 * 3. Reports any non-pooled connections that need fixing
 *
 * Usage: npx tsx scripts/audit-neon-connections.ts
 */

import { getDb } from "../src/lib/db";

async function auditNeonConnections() {
  const sql = getDb();

  console.log("🔍 Auditing Neon database connections...\n");

  // 1. Check main DATABASE_URL
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
  }

  const isMainPooled = databaseUrl.includes("-pooler");
  console.log(`📊 Main DATABASE_URL: ${isMainPooled ? "✅ POOLED" : "❌ DIRECT"}`);
  if (!isMainPooled) {
    console.log(`   URL pattern: ${databaseUrl.split("@")[1]?.split("/")[0] || "unknown"}`);
    console.log("   ⚠️  This should use a pooled endpoint ending with -pooler.{region}.aws.neon.tech");
  }

  // 2. Check connection strings stored in infra table
  console.log("\n📋 Checking stored connection strings in infra table:");
  const infraConnections = await sql`
    SELECT
      i.id,
      i.company_id,
      c.slug as company_slug,
      i.service,
      i.status,
      i.config->>'connection_string' as connection_string
    FROM infra i
    JOIN companies c ON c.id = i.company_id
    WHERE i.service = 'neon'
      AND i.status = 'active'
      AND i.config->>'connection_string' IS NOT NULL
  `;

  let issues = 0;

  for (const infra of infraConnections) {
    const connStr = infra.connection_string;
    const isPooled = connStr.includes("-pooler");
    const status = isPooled ? "✅ POOLED" : "❌ DIRECT";

    console.log(`   ${infra.company_slug}: ${status}`);
    if (!isPooled) {
      issues++;
      const host = connStr.split("@")[1]?.split("/")[0];
      console.log(`      Host: ${host}`);
      console.log(`      Should be: ${host?.replace(/^ep-[^.]+/, "$&-pooler") || "unknown"}`);
    }
  }

  // 3. Summary
  console.log("\n📊 Audit Summary:");
  console.log(`   Main Hive DATABASE_URL: ${isMainPooled ? "✅" : "❌"}`);
  console.log(`   Company connections: ${infraConnections.length - issues}/${infraConnections.length} pooled`);

  if (!isMainPooled || issues > 0) {
    console.log("\n🚨 Issues found that need attention:");
    if (!isMainPooled) {
      console.log("   - Main DATABASE_URL should use pooled endpoint");
      console.log("     Update in Vercel dashboard: Environment Variables");
    }
    if (issues > 0) {
      console.log(`   - ${issues} company connection string(s) not pooled`);
      console.log("     These are stored in the infra table and used by assess route");
    }

    console.log("\n💡 Benefits of pooled connections:");
    console.log("   - Up to 10,000 concurrent connections vs 100 direct");
    console.log("   - Built-in connection pooling with PgBouncer");
    console.log("   - Better performance for serverless functions");
    console.log("   - Prevents connection limit errors under load");

    process.exit(1);
  } else {
    console.log("\n✅ All connections are properly pooled!");
    console.log("   Your serverless functions are optimized for high concurrency.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  auditNeonConnections().catch((error) => {
    console.error("Audit failed:", error);
    process.exit(1);
  });
}

export { auditNeonConnections };