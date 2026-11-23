import { defineConfig, devices } from '@playwright/test';

/**
 * Everything environment-specific comes from env vars, so the same image runs
 * inside a Bunnyshell environment, in CI, or on a laptop.
 *
 *   BASE_URL      URL the tests open with page.goto('/')
 *   PW_BROWSERS   comma-separated: chromium,firefox,webkit (default: chromium)
 *   REPORT_DIR    where the HTML report is written (default: playwright-report)
 *   PW_TRACE      trace mode (default: retain-on-failure; "on" keeps traces for passing tests too)
 *   PW_VIDEO      video mode (default: retain-on-failure)
 */
type Mode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';

const browsers = (process.env.PW_BROWSERS || 'chromium').split(',').map((b) => b.trim());

const allProjects = {
  chromium: { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  firefox: { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  webkit: { name: 'webkit', use: { ...devices['Desktop Safari'] } },
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  /* One retry on CI separates flaky tests from real failures in the report. */
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: process.env.REPORT_DIR || 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL,
    /* Keep the evidence for every failure: trace, screenshot and video. */
    trace: (process.env.PW_TRACE as Mode) || 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: (process.env.PW_VIDEO as Mode) || 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: browsers.map((b) => {
    const project = allProjects[b as keyof typeof allProjects];
    if (!project) throw new Error(`Unknown browser "${b}" in PW_BROWSERS`);
    return project;
  }),
});
