import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the REAL stack through a real browser (API + relay + workers + MongoDB + Redis + the
 * bundled fake SMTP server). Start it first: `bun run dev` in the repository root (after `bun run web:build`).
 *
 *   E2E_URL        where the app is served (default http://localhost:3100)
 *   E2E_SMTP_HOST / E2E_SMTP_PORT   the fake SMTP server the API/workers can reach (default localhost:2525)
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
