import { type Page, expect } from "@playwright/test";

export const SMTP_HOST = process.env.E2E_SMTP_HOST ?? "localhost";
export const SMTP_PORT = process.env.E2E_SMTP_PORT ?? "2525";
export const PASSWORD = "correct-horse-battery-1";

export const uniqueEmail = (tag = "e2e") => `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.test`;

export async function register(page: Page, email = uniqueEmail()) {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  return email;
}

/** Adds the bundled fake SMTP server as an account through the UI. */
export async function addSink(page: Page, opts: { perSecond?: string; name?: string } = {}) {
  await page.goto("/smtp");
  await page.getByRole("button", { name: "Add account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(opts.name ?? "E2E sink");
  await dialog.getByLabel("SMTP host").fill(SMTP_HOST);
  await dialog.getByRole("spinbutton", { name: "Port" }).fill(SMTP_PORT);
  await dialog.getByRole("textbox", { name: "Username", exact: true }).fill("u");
  await dialog.locator('input[type="password"]').fill("p");
  await dialog.getByLabel("From address").fill("sender@e2e.test");
  await dialog.getByLabel("Per second").fill(opts.perSecond ?? "50");
  await dialog.getByRole("button", { name: "Verify and save" }).click();
  await expect(page.getByText("SMTP account verified and saved")).toBeVisible();
}
