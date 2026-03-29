/**
 * Embeddings utilities for semantic search using pgvector
 * Generates text embeddings via OpenRouter and provides similarity search functions
 */

import { getSettingValue } from "./settings";

// OpenAI text-embedding-3-small model through OpenRouter
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSION = 1536;

interface EmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Generate embeddings for text using OpenRouter
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text?.trim()) {
    throw new Error("Text cannot be empty");
  }

  const apiKey = await getSettingValue("openrouter_api_key");
  if (!apiKey) {
    throw new Error("openrouter_api_key not configured in settings");
  }

  // Clean and truncate text to avoid token limits
  const cleanText = text.trim().slice(0, 8000); // Conservative limit for embeddings

  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://hive.carloshmiranda.com",
      "X-Title": "Hive Venture Orchestrator",
    },
    body: JSON.stringify({
      input: cleanText,
      model: EMBEDDING_MODEL,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding generation failed: ${error}`);
  }

  const data: EmbeddingResponse = await response.json();

  if (!data.data?.[0]?.embedding) {
    throw new Error("Invalid embedding response");
  }

  return data.data[0].embedding;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Generate embedding for playbook entry content
 * Combines insight and domain for comprehensive semantic representation
 */
export async function generatePlaybookEmbedding(insight: string, domain: string, evidence?: any): Promise<number[]> {
  // Combine insight, domain, and evidence summary for richer embeddings
  let combinedText = `Domain: ${domain}\nInsight: ${insight}`;

  if (evidence && typeof evidence === 'object') {
    try {
      const evidenceText = Object.entries(evidence)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      combinedText += `\nEvidence: ${evidenceText}`;
    } catch {
      // Ignore evidence if it can't be serialized
    }
  }

  return generateEmbedding(combinedText);
}

/**
 * Batch generate embeddings for multiple texts
 */
export async function batchGenerateEmbeddings(texts: string[], batchSize = 10): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchPromises = batch.map(text => generateEmbedding(text));

    try {
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    } catch (error) {
      console.error(`Failed to generate embeddings for batch ${i}-${i + batchSize}:`, error);
      // Add zero vectors for failed embeddings to maintain array length
      results.push(...batch.map(() => new Array(EMBEDDING_DIMENSION).fill(0)));
    }

    // Rate limiting - wait 100ms between batches
    if (i + batchSize < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

export { EMBEDDING_DIMENSION };