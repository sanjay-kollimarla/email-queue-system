import { defineConfig, devices } from "@playwright/test";

/** Captures README screenshots (see e2e/screenshots.capture.ts). Same environment variables as the e2e config. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /screenshots\.capture\.ts/,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_URL ?? "http://localhost:3100" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
