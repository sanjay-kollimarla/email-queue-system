import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { addSink, register } from "./helpers";

/**
 * Not a test: captures the README screenshots from the running stack.
 *   node node_modules/@playwright/test/cli.js test -c playwright.screens.config.ts
 */
const OUT = process.env.SHOT_DIR ?? "../docs/screenshots";
mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });

test("capture", async ({ page }) => {
  test.setTimeout(180_000);

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-login.png` });

  await register(page);
  await addSink(page, { name: "Company SMTP", perSecond: "40" });
  await page.screenshot({ path: `${OUT}/04-smtp-accounts.png` });

  // a campaign big enough to still be draining while we take the dashboard shots
  await page.goto("/send");
  await page.getByRole("radio", { name: "Campaign" }).check({ force: true });
  const rows = [
    "email,name,plan",
    ...Array.from({ length: 1000 }, (_, i) => `customer${i}@example.com,Customer ${i},${i % 3 ? "Pro" : "Team"}`),
  ];
  await page.getByLabel("Recipients").fill(rows.join("\n"));
  await page.getByLabel("Subject").fill("Welcome aboard, {{name}}!");
  await page.getByRole("radio", { name: "HTML" }).check({ force: true });
  await page.getByLabel("Message body").fill("<h2>Hi {{name}} 👋</h2><p>Thanks for choosing the <b>{{plan}}</b> plan.</p>");
  await page.getByRole("button", { name: /Send to 1,000/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/03-compose.png` });
  await page.getByRole("button", { name: /Send to 1,000/ }).click();
  await expect(page.getByText("1,000 emails accepted")).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.waitForTimeout(18000); // mid-campaign: the controller has ramped up and the queue is draining
  await page.screenshot({ path: `${OUT}/02-dashboard.png` });

  await page.goto("/emails");
  await expect(page.getByRole("row").nth(1)).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/05-emails.png` });

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/06-dashboard-dark.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/07-dashboard-mobile.png` });
});
