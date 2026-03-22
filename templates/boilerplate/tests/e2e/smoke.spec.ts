import { test, expect } from "@playwright/test";

// Smoke tests — minimal checks that the site is alive and core pages work.
// These run on every deploy via post-deploy.yml and on PRs via e2e.yml.

// Known-safe errors to ignore (external services, expected auth failures)
const SAFE_ERRORS = [
  /favicon\.ico.*404/,
  /ResizeObserver loop/,
  /accounts\.google\.com/,
  /Loading chunk.*failed/,
];

function isSafeError(msg: string): boolean {
  return SAFE_ERRORS.some((re) => re.test(msg));
}

test.describe("Smoke tests", () => {
  test("homepage loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (!isSafeError(err.message)) errors.push(err.message);
    });

    const response = await page.goto("/");
    expect(response?.status()).toBeLessThan(400);

    // Page should have content (not blank)
    const body = await page.textContent("body");
    expect(body?.trim().length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test("health endpoint responds OK", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("ok");
  });

  test("stats endpoint responds", async ({ request }) => {
    const response = await request.get("/api/stats");
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
  });

  test("no console errors on key pages", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (!isSafeError(err.message)) errors.push(err.message);
    });

    // Test homepage
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(errors).toEqual([]);
  });
});
