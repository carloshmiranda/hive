#!/usr/bin/env tsx

import { getDb } from "../src/lib/db";

async function queryRecentErrors() {
  try {
    const sql = getDb();

    console.log("🔍 Querying errors from last 48 hours...");

    const errors = await sql`
      SELECT aa.agent, aa.error, aa.description, aa.company_id, c.slug,
        COUNT(*) as occurrences
      FROM agent_actions aa
      LEFT JOIN companies c ON c.id = aa.company_id
      WHERE aa.status = 'failed'
        AND aa.finished_at > NOW() - INTERVAL '48 hours'
      GROUP BY aa.agent, aa.error, aa.description, aa.company_id, c.slug
      ORDER BY occurrences DESC
      LIMIT 15
    `;

    console.log(`Found ${errors.length} error patterns:\n`);

    if (errors.length === 0) {
      console.log("✅ No failed agent actions in the last 48 hours!");
      return;
    }

    errors.forEach((error, index) => {
      console.log(`${index + 1}. ${error.agent} (${error.occurrences} times)`);
      console.log(`   Company: ${error.slug || 'N/A'} (${error.company_id || 'N/A'})`);
      console.log(`   Error: ${error.error || 'N/A'}`);
      console.log(`   Description: ${error.description || 'N/A'}`);
      console.log('');
    });

    // Export the data for further analysis
    console.log("Raw data for analysis:");
    console.log(JSON.stringify(errors, null, 2));

  } catch (error) {
    console.error("❌ Failed to query errors:", error);
    process.exit(1);
  }
}

queryRecentErrors();