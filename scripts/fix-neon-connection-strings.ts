#!/usr/bin/env tsx
/**
 * Fix script to convert any non-pooled Neon connection strings to pooled endpoints
 *
 * This script:
 * 1. Identifies connection strings in the infra table that don't use pooled endpoints
 * 2. Updates them to use the pooled (-pooler) version
 * 3. Reports what was changed
 *
 * Usage: npx tsx scripts/fix-neon-connection-strings.ts [--dry-run]
 */

import { getDb } from "../src/lib/db";

async function fixNeonConnectionStrings(dryRun = false) {
  const sql = getDb();

  console.log(`🔧 ${dryRun ? "DRY RUN: " : ""}Fixing Neon connection strings...\n`);

  // Find all infra records with Neon connection strings that aren't pooled
  const infraConnections = await sql`
    SELECT
      i.id,
      i.company_id,
      c.slug as company_slug,
      i.service,
      i.status,
      i.config->>'connection_string' as connection_string,
      i.config as full_config
    FROM infra i
    JOIN companies c ON c.id = i.company_id
    WHERE i.service = 'neon'
      AND i.status = 'active'
      AND i.config->>'connection_string' IS NOT NULL
      AND i.config->>'connection_string' NOT LIKE '%%-pooler%%'
  `;

  if (infraConnections.length === 0) {
    console.log("✅ No non-pooled connection strings found. All connections are already optimized!");
    return;
  }

  console.log(`📋 Found ${infraConnections.length} connection string(s) to fix:`);

  let fixedCount = 0;

  for (const infra of infraConnections) {
    const oldConnectionString = infra.connection_string;

    // Convert to pooled endpoint
    // Example: postgresql://user:pass@ep-123-abc.us-east-2.aws.neon.tech/db
    // Becomes: postgresql://user:pass@ep-123-abc-pooler.us-east-2.aws.neon.tech/db
    const newConnectionString = oldConnectionString.replace(
      /(@ep-[^.]+)\.([^/]+)/,
      '$1-pooler.$2'
    );

    console.log(`\n   ${infra.company_slug} (infra.id=${infra.id}):`);
    console.log(`   OLD: ${oldConnectionString.replace(/\/\/[^@]+@/, '//***@')}`);
    console.log(`   NEW: ${newConnectionString.replace(/\/\/[^@]+@/, '//***@')}`);

    if (!dryRun) {
      // Update the connection string in the config JSON
      const updatedConfig = {
        ...infra.full_config,
        connection_string: newConnectionString
      };

      await sql`
        UPDATE infra
        SET config = ${JSON.stringify(updatedConfig)}::jsonb,
            updated_at = NOW()
        WHERE id = ${infra.id}
      `;

      console.log("   ✅ Updated");
      fixedCount++;
    } else {
      console.log("   ⏭️  Would update (dry run)");
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ${dryRun ? "Would fix" : "Fixed"}: ${dryRun ? infraConnections.length : fixedCount} connection string(s)`);

  if (!dryRun && fixedCount > 0) {
    console.log("\n💡 Benefits of pooled connections:");
    console.log("   - Up to 10,000 concurrent connections vs 100 direct");
    console.log("   - Built-in PgBouncer connection pooling");
    console.log("   - Better performance for serverless functions");
    console.log("   - Prevents 'too many connections' errors under load");

    console.log("\n⚠️  Next steps:");
    console.log("   - Company applications will use the new pooled endpoints on next deploy");
    console.log("   - Consider redeploying affected companies to pick up the changes immediately");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  if (dryRun) {
    console.log("Running in DRY RUN mode. No changes will be made.\n");
  }

  try {
    await fixNeonConnectionStrings(dryRun);
  } catch (error) {
    console.error("Fix failed:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { fixNeonConnectionStrings };