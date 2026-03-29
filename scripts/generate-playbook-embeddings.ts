#!/usr/bin/env npx tsx

/**
 * Generate embeddings for existing playbook entries
 * Run: npx tsx scripts/generate-playbook-embeddings.ts
 */

import { getDb } from "../src/lib/db";
import { generatePlaybookEmbedding, batchGenerateEmbeddings } from "../src/lib/embeddings";

interface PlaybookEntry {
  id: string;
  domain: string;
  insight: string;
  evidence: any;
  embedding: any;
}

async function main() {
  console.log("🚀 Starting playbook embedding generation...");

  const sql = getDb();

  // Get all playbook entries that don't have embeddings
  const entries = await sql`
    SELECT id, domain, insight, evidence, embedding
    FROM playbook
    WHERE superseded_by IS NULL
    ORDER BY created_at ASC
  ` as PlaybookEntry[];

  console.log(`📚 Found ${entries.length} playbook entries`);

  const missingEmbeddings = entries.filter(entry => !entry.embedding);
  console.log(`🔍 ${missingEmbeddings.length} entries need embeddings`);

  if (missingEmbeddings.length === 0) {
    console.log("✅ All playbook entries already have embeddings!");
    return;
  }

  let processed = 0;
  let errors = 0;
  const batchSize = 5; // Small batch size to avoid rate limits

  console.log(`🔄 Processing ${missingEmbeddings.length} entries in batches of ${batchSize}...`);

  for (let i = 0; i < missingEmbeddings.length; i += batchSize) {
    const batch = missingEmbeddings.slice(i, i + batchSize);
    console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(missingEmbeddings.length / batchSize)}`);

    for (const entry of batch) {
      try {
        console.log(`   ⚡ Generating embedding for: ${entry.domain} - ${entry.insight.slice(0, 50)}...`);

        const embedding = await generatePlaybookEmbedding(
          entry.insight,
          entry.domain,
          entry.evidence
        );

        // Convert to pgvector format
        const embeddingVector = `[${embedding.join(',')}]`;

        await sql`
          UPDATE playbook
          SET embedding = ${embeddingVector}::vector
          WHERE id = ${entry.id}
        `;

        processed++;
        console.log(`   ✅ Updated entry ${entry.id}`);

      } catch (error) {
        errors++;
        console.error(`   ❌ Failed to generate embedding for ${entry.id}:`, error instanceof Error ? error.message : error);

        // Continue processing other entries even if one fails
        continue;
      }
    }

    // Rate limiting between batches
    if (i + batchSize < missingEmbeddings.length) {
      console.log("   ⏳ Waiting 2 seconds to avoid rate limits...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n🎉 Embedding generation complete!`);
  console.log(`   ✅ Successfully processed: ${processed}`);
  console.log(`   ❌ Errors: ${errors}`);
  console.log(`   📊 Total entries: ${entries.length}`);

  // Verify the results
  const updatedEntries = await sql`
    SELECT COUNT(*) as total,
           COUNT(embedding) as with_embeddings
    FROM playbook
    WHERE superseded_by IS NULL
  `;

  const stats = updatedEntries[0];
  console.log(`\n📈 Final stats:`);
  console.log(`   Total entries: ${stats.total}`);
  console.log(`   With embeddings: ${stats.with_embeddings}`);
  console.log(`   Coverage: ${Math.round((stats.with_embeddings / stats.total) * 100)}%`);

  if (stats.with_embeddings === stats.total) {
    console.log("🎯 Perfect! All playbook entries now have embeddings.");
  } else {
    console.log(`⚠️  ${stats.total - stats.with_embeddings} entries still missing embeddings.`);
  }
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});