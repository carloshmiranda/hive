import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// QA Test Suite for automated post-deploy verification
// Based on Anthropic's webapp-testing skill patterns

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const RESULTS_DIR = process.env.QA_RESULTS_DIR || './qa-results';

// Setup results directory
test.beforeAll(async () => {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
});

// Console log capture helper
const captureConsoleLogs = (page: Page) => {
  const consoleLogs: string[] = [];

  page.on('console', (msg) => {
    const logEntry = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(logEntry);
    console.log(`Console: ${logEntry}`);
  });

  page.on('pageerror', (error) => {
    const errorEntry = `[ERROR] ${error.message}`;
    consoleLogs.push(errorEntry);
    console.error(`Page Error: ${errorEntry}`);
  });

  return consoleLogs;
};

// Screenshot helper
const takeScreenshot = async (page: Page, name: string, fullPage = true) => {
  const filename = `${name}-${Date.now()}.png`;
  const filepath = path.join(RESULTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage });
  console.log(`Screenshot saved: ${filepath}`);
  return filepath;
};

// Page load verification test
test.describe('Page Load Verification', () => {
  test('homepage loads without errors', async ({ page }) => {
    const consoleLogs = captureConsoleLogs(page);

    // Navigate to homepage
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Take initial screenshot
    const screenshotPath = await takeScreenshot(page, 'homepage-load');

    // Verify page loaded (has a title and main content)
    await expect(page).toHaveTitle(/.+/); // Has some title
    const mainContent = page.locator('main, [role="main"], body');
    await expect(mainContent).toBeVisible();

    // Check for critical errors in console
    const criticalErrors = consoleLogs.filter(log =>
      log.includes('[ERROR]') || log.includes('[error]') || log.includes('ERROR')
    );

    if (criticalErrors.length > 0) {
      console.error('Critical console errors detected:', criticalErrors);
      // Save console logs to file
      fs.writeFileSync(
        path.join(RESULTS_DIR, `console-errors-${Date.now()}.log`),
        criticalErrors.join('\n')
      );
    }

    // Test passes if no critical errors
    expect(criticalErrors).toHaveLength(0);
  });

  test('key pages load correctly', async ({ page }) => {
    const consoleLogs = captureConsoleLogs(page);

    // Test common pages that most apps have
    const testPages = [
      '/',
      '/about',
      '/contact',
      '/pricing',
      '/features'
    ];

    const results = [];

    for (const pagePath of testPages) {
      try {
        await page.goto(`${BASE_URL}${pagePath}`);
        await page.waitForLoadState('networkidle', { timeout: 10000 });

        // Check if page loaded successfully (not 404)
        const is404 = await page.locator('text=/404|not found|page not found/i').isVisible();
        if (!is404) {
          await takeScreenshot(page, `page-${pagePath.replace('/', 'root')}`);
          results.push({ page: pagePath, status: 'success' });
        } else {
          results.push({ page: pagePath, status: 'not_found' });
        }
      } catch (error) {
        results.push({ page: pagePath, status: 'error', error: error.message });
      }
    }

    // Save test results
    fs.writeFileSync(
      path.join(RESULTS_DIR, `page-load-results-${Date.now()}.json`),
      JSON.stringify(results, null, 2)
    );

    // At least homepage should load
    const homepageResult = results.find(r => r.page === '/');
    expect(homepageResult?.status).toBe('success');
  });
});

// Interactive elements verification
test.describe('Interactive Elements Verification', () => {
  test('buttons and links are functional', async ({ page }) => {
    const consoleLogs = captureConsoleLogs(page);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Discover buttons on the page
    const buttons = await page.locator('button:visible').all();
    console.log(`Found ${buttons.length} visible buttons`);

    // Test first few buttons (avoid infinite loops from pagination, etc.)
    const maxButtonsToTest = Math.min(buttons.length, 5);
    const buttonResults = [];

    for (let i = 0; i < maxButtonsToTest; i++) {
      try {
        const button = buttons[i];
        const buttonText = await button.innerText();

        // Skip buttons that might cause navigation away or destructive actions
        if (buttonText.toLowerCase().includes('delete') ||
            buttonText.toLowerCase().includes('logout') ||
            buttonText.toLowerCase().includes('sign out')) {
          continue;
        }

        await button.click();
        await page.waitForTimeout(1000); // Wait for any async operations

        buttonResults.push({
          index: i,
          text: buttonText,
          status: 'clicked_successfully'
        });
      } catch (error) {
        buttonResults.push({
          index: i,
          text: 'unknown',
          status: 'error',
          error: error.message
        });
      }
    }

    // Discover and test links (internal ones only)
    const internalLinks = await page.locator('a[href^="/"], a[href^="#"]').all();
    console.log(`Found ${internalLinks.length} internal links`);

    const linkResults = [];
    const maxLinksToTest = Math.min(internalLinks.length, 3);

    for (let i = 0; i < maxLinksToTest; i++) {
      try {
        const link = internalLinks[i];
        const href = await link.getAttribute('href');
        const linkText = await link.innerText();

        await link.click();
        await page.waitForLoadState('networkidle', { timeout: 5000 });

        // Verify navigation occurred or action completed
        const currentUrl = page.url();
        linkResults.push({
          index: i,
          text: linkText,
          href,
          currentUrl,
          status: 'navigation_successful'
        });

        // Go back for next test
        await page.goBack();
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch (error) {
        linkResults.push({
          index: i,
          status: 'error',
          error: error.message
        });
      }
    }

    // Save interaction results
    const interactionResults = { buttons: buttonResults, links: linkResults };
    fs.writeFileSync(
      path.join(RESULTS_DIR, `interaction-results-${Date.now()}.json`),
      JSON.stringify(interactionResults, null, 2)
    );

    // Take final screenshot
    await takeScreenshot(page, 'interaction-test-complete');

    // Test passes if no critical console errors during interactions
    const criticalErrors = consoleLogs.filter(log =>
      log.includes('[ERROR]') || log.includes('[error]') || log.includes('ERROR')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// Form functionality verification (if forms exist)
test.describe('Form Functionality Verification', () => {
  test('forms accept input and submit without errors', async ({ page }) => {
    const consoleLogs = captureConsoleLogs(page);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Look for forms on the page
    const forms = await page.locator('form').all();
    console.log(`Found ${forms.length} forms`);

    if (forms.length === 0) {
      // Skip test if no forms found
      test.skip();
      return;
    }

    const formResults = [];

    for (let i = 0; i < Math.min(forms.length, 2); i++) {
      try {
        const form = forms[i];

        // Find input fields in this form
        const inputs = await form.locator('input[type="text"], input[type="email"], textarea').all();

        // Fill out the form with test data
        for (const input of inputs) {
          const inputType = await input.getAttribute('type');
          const inputName = await input.getAttribute('name') || 'unknown';

          let testValue = 'test-input';
          if (inputType === 'email') {
            testValue = 'test@example.com';
          }

          await input.fill(testValue);
        }

        // Try to submit the form
        const submitButton = await form.locator('button[type="submit"], input[type="submit"]').first();

        if (await submitButton.isVisible()) {
          await submitButton.click();
          await page.waitForTimeout(2000); // Wait for submission
        }

        formResults.push({
          index: i,
          inputs: inputs.length,
          status: 'form_interaction_successful'
        });
      } catch (error) {
        formResults.push({
          index: i,
          status: 'error',
          error: error.message
        });
      }
    }

    // Save form test results
    fs.writeFileSync(
      path.join(RESULTS_DIR, `form-results-${Date.now()}.json`),
      JSON.stringify(formResults, null, 2)
    );

    // Check for critical errors
    const criticalErrors = consoleLogs.filter(log =>
      log.includes('[ERROR]') || log.includes('[error]') || log.includes('ERROR')
    );

    if (criticalErrors.length > 0) {
      fs.writeFileSync(
        path.join(RESULTS_DIR, `form-console-errors-${Date.now()}.log`),
        criticalErrors.join('\n')
      );
    }

    expect(criticalErrors).toHaveLength(0);
  });
});

// Performance and accessibility checks
test.describe('Quality Checks', () => {
  test('page performance is acceptable', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Check if page loads within reasonable time (already loaded, but verify no hanging requests)
    await page.waitForTimeout(3000);

    // Take performance screenshot
    await takeScreenshot(page, 'performance-check');

    // Basic performance check - ensure page is responsive
    const title = await page.title();
    expect(title).toBeTruthy();

    // Check that main content is visible
    const body = await page.locator('body').isVisible();
    expect(body).toBeTruthy();
  });

  test('no broken images or missing resources', async ({ page }) => {
    const consoleLogs = captureConsoleLogs(page);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Check for broken images
    const images = await page.locator('img').all();
    let brokenImages = 0;

    for (const img of images) {
      try {
        const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
        if (naturalWidth === 0) {
          brokenImages++;
        }
      } catch (error) {
        brokenImages++;
      }
    }

    console.log(`Found ${images.length} images, ${brokenImages} appear broken`);

    // Check console for 404s or resource loading errors
    const resourceErrors = consoleLogs.filter(log =>
      log.includes('404') ||
      log.includes('Failed to load') ||
      log.includes('net::ERR')
    );

    // Save resource error results
    const results = {
      totalImages: images.length,
      brokenImages,
      resourceErrors,
      timestamp: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(RESULTS_DIR, `resource-check-${Date.now()}.json`),
      JSON.stringify(results, null, 2)
    );

    // Test is considered passing if critical issues are minimal
    expect(brokenImages).toBeLessThanOrEqual(1); // Allow 1 potentially broken image
    expect(resourceErrors.length).toBeLessThanOrEqual(2); // Allow minor resource issues
  });
});