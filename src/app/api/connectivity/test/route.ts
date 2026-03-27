import { json } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";
import { getQStashClient } from "@/lib/qstash";

async function runConnectivityTest(servicesToTest: string[] = ['all']) {

  const results: Record<string, { status: string; latency?: number; detail?: string; error?: string }> = {};

  // Helper to measure latency
  const testWithLatency = async (name: string, testFn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await testFn();
      const latency = Date.now() - start;
      results[name] = { status: 'ok', latency, detail: `Connected in ${latency}ms` };
    } catch (error: any) {
      const latency = Date.now() - start;
      results[name] = {
        status: 'error',
        latency,
        error: error.message,
        detail: `Failed after ${latency}ms`
      };
    }
  };

  // Test QStash connectivity
  if (servicesToTest.includes('all') || servicesToTest.includes('qstash')) {
    await testWithLatency('qstash', async () => {
      const client = getQStashClient();
      // Test QStash by getting schedules (lightweight operation)
      await client.schedules.list();
    });
  }

  // Test GitHub API
  if (servicesToTest.includes('all') || servicesToTest.includes('github')) {
    await testWithLatency('github', async () => {
      const token = await getSettingValue("github_token");
      if (!token) throw new Error("GitHub token not configured");

      const res = await fetch("https://api.github.com/rate_limit", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    });
  }

  // Test Vercel API
  if (servicesToTest.includes('all') || servicesToTest.includes('vercel')) {
    await testWithLatency('vercel', async () => {
      const token = await getSettingValue("vercel_token");
      if (!token) throw new Error("Vercel token not configured");

      const res = await fetch("https://api.vercel.com/v2/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Vercel API returned ${res.status}`);
    });
  }

  // Test Stripe API
  if (servicesToTest.includes('all') || servicesToTest.includes('stripe')) {
    await testWithLatency('stripe', async () => {
      const key = await getSettingValue("stripe_secret_key");
      if (!key) throw new Error("Stripe secret key not configured");

      const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) throw new Error(`Stripe API returned ${res.status}`);
    });
  }

  // Test Resend API
  if (servicesToTest.includes('all') || servicesToTest.includes('resend')) {
    await testWithLatency('resend', async () => {
      const key = await getSettingValue("resend_api_key");
      if (!key) throw new Error("Resend API key not configured");

      const res = await fetch("https://api.resend.com/domains", {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`Resend API returned ${res.status}`);
    });
  }

  // Test OpenRouter API (LLM provider)
  if (servicesToTest.includes('all') || servicesToTest.includes('openrouter')) {
    await testWithLatency('openrouter', async () => {
      // Check if we can reach OpenRouter models endpoint
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) throw new Error(`OpenRouter API returned ${res.status}`);
    });
  }

  // Test Telegram Bot API (if configured)
  if (servicesToTest.includes('all') || servicesToTest.includes('telegram')) {
    await testWithLatency('telegram', async () => {
      const token = await getSettingValue("telegram_bot_token");
      if (!token) throw new Error("Telegram bot token not configured");

      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (!res.ok) throw new Error(`Telegram API returned ${res.status}`);
    });
  }

  // Test Neon API (if configured)
  if (servicesToTest.includes('all') || servicesToTest.includes('neon')) {
    await testWithLatency('neon', async () => {
      const key = await getSettingValue("neon_api_key");
      if (!key) throw new Error("Neon API key not configured");

      const res = await fetch("https://console.neon.tech/api/v2/projects", {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) throw new Error(`Neon API returned ${res.status}`);
    });
  }

  // Overall status
  const statuses = Object.values(results).map(r => r.status);
  const overall = statuses.includes('error') ? 'failed' : 'passed';

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    results,
    summary: {
      total: statuses.length,
      passed: statuses.filter(s => s === 'ok').length,
      failed: statuses.filter(s => s === 'error').length,
    }
  };
}

export async function GET() {
  await requireAuth();
  const result = await runConnectivityTest();
  return json(result);
}

export async function POST(request: Request) {
  await requireAuth();

  const { services } = await request.json();
  const servicesToTest = services || ['all'];

  const result = await runConnectivityTest(servicesToTest);
  return json(result);
}