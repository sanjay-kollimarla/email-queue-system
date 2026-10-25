import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PASSWORD, addSink, register, uniqueEmail } from "./helpers";

test.describe("authentication", () => {
  test("anonymous visitors are sent to the login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("validation messages are shown before any request", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page.getByText("Use at least 10 characters")).toBeVisible();
  });

  test("register, reload keeps the session, sign out, wrong password is rejected, sign in works", async ({ page }) => {
    const email = await register(page);

    // the refresh token is an HttpOnly cookie: reload restores the session without any stored credential
    await page.reload();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toMatch(/token|eyJ/i);
    expect(await page.evaluate(() => document.cookie)).not.toContain("eq_rt"); // HttpOnly: invisible to scripts

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password")).toBeVisible();

    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("duplicate registration is reported on the email field", async ({ page }) => {
    const email = await register(page);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("An account with this email already exists")).toBeVisible();
  });
});

test.describe("sending mail end to end", () => {
  test("a new account is guided to connect SMTP, then a rate must be declared", async ({ page }) => {
    await register(page);
    await expect(page.getByText("Connect your SMTP account to start")).toBeVisible();

    await page.goto("/smtp");
    await page.getByRole("button", { name: "Add your first account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("No rate");
    await dialog.getByLabel("SMTP host").fill("mail.example.org");
    await dialog.getByRole("textbox", { name: "Username", exact: true }).fill("u");
    await dialog.locator('input[type="password"]').fill("p");
    await dialog.getByLabel("From address").fill("a@example.org");
    await dialog.getByRole("button", { name: "Verify and save" }).click();
    await expect(dialog.getByText("Declare at least a per-second or a per-minute limit")).toBeVisible();
  });

  test("known providers get a documented-limits hint that can fill the form", async ({ page }) => {
    await register(page);
    await page.goto("/smtp");
    await page.getByRole("button", { name: "Add your first account" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("SMTP host").fill("smtp.office365.com");
    await expect(dialog.getByText("microsoft365 detected")).toBeVisible();
    await dialog.getByRole("button", { name: "Fill in the documented limits" }).click();
    await expect(dialog.getByLabel("Per minute")).toHaveValue("30");
    await expect(dialog.getByLabel("Max parallel connections")).toHaveValue("3");
  });

  test("single email: accepted, appears in the list and reaches Sent", async ({ page }) => {
    await register(page);
    await addSink(page);

    await page.goto("/send");
    await page.getByRole("textbox", { name: "To", exact: true }).fill("reader@example.com");
    await page.getByLabel("Subject").fill("Hello from e2e");
    await page.getByLabel("Message body").fill("Plain text body");
    await page.getByRole("button", { name: "Send email" }).click();
    await expect(page.getByText("Email accepted")).toBeVisible();

    await page.goto("/emails");
    const row = page.getByRole("row", { name: /reader@example\.com/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("Sent")).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button", { name: "reader@example.com" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("Email details")).toBeVisible();
    await expect(drawer.getByText(/250/)).toBeVisible(); // the SMTP server's answer
  });

  test("campaign: CSV recipients with variables, live preview, then delivery", async ({ page }) => {
    await register(page);
    await addSink(page);
    await page.goto("/send");
    await page.getByRole("radio", { name: "Campaign" }).check({ force: true });
    await page.getByLabel("Recipients").fill("email,name\nada@example.com,Ada\ngrace@example.com,Grace\nnot-an-email,Oops");
    await expect(page.getByText("2 valid")).toBeVisible();
    await expect(page.getByText(/1 invalid/)).toBeVisible();

    await page.getByLabel("Subject").fill("Hi {{name}}");
    await page.getByLabel("Message body").fill("Dear {{name}}, welcome!");
    await expect(page.getByText("Hi Ada")).toBeVisible(); // preview renders the first recipient's variables

    // invalid rows block sending until fixed
    await page.getByRole("button", { name: /Send to 2/ }).click();
    await expect(page.getByText("1 invalid address: fix or remove them")).toBeVisible();

    await page.getByLabel("Recipients").fill("email,name\nada@example.com,Ada\ngrace@example.com,Grace");
    await page.getByRole("button", { name: "Send to 2" }).click();
    await expect(page.getByText("2 emails accepted")).toBeVisible();

    await page.goto("/emails");
    await expect(page.getByRole("row", { name: /ada@example\.com/ }).getByText("Sent")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("row", { name: /grace@example\.com/ }).getByText("Sent")).toBeVisible({ timeout: 30_000 });
  });

  test("suppressed recipients are never sent to", async ({ page }) => {
    await register(page);
    await addSink(page);

    await page.goto("/suppressions");
    await page.getByLabel("Email address").fill("blocked@example.com");
    await page.getByRole("button", { name: "Suppress", exact: true }).click();
    await expect(page.getByText("blocked@example.com")).toBeVisible();

    await page.goto("/send");
    await page.getByRole("textbox", { name: "To", exact: true }).fill("blocked@example.com");
    await page.getByLabel("Subject").fill("Should not go");
    await page.getByLabel("Message body").fill("nope");
    await page.getByRole("button", { name: "Send email" }).click();
    await expect(page.getByText("Email accepted")).toBeVisible();

    await page.goto("/emails");
    await expect(page.getByRole("row", { name: /blocked@example\.com/ }).getByText("Suppressed")).toBeVisible();
  });

  test("dashboard reflects deliveries and shows the account's rate state", async ({ page }) => {
    await register(page);
    await addSink(page, { perSecond: "50", name: "Rate demo" });
    await page.goto("/send");
    await page.getByRole("radio", { name: "Campaign" }).check({ force: true });
    const rows = Array.from({ length: 30 }, (_, i) => `u${i}@example.com`).join("\n");
    await page.getByLabel("Recipients").fill(rows);
    await page.getByLabel("Subject").fill("Dashboard check");
    await page.getByLabel("Message body").fill("hello");
    await page.getByRole("button", { name: "Send to 30" }).click();
    await expect(page.getByText("30 emails accepted")).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Rate demo" })).toBeVisible();
    await expect(page.getByText("of 50/s allowed")).toBeVisible();
    await expect(page.getByLabel("Totals").getByText("30", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("img", { name: /Emails sent per second/ })).toBeVisible();
  });
});

test.describe("settings and preferences", () => {
  test("theme choice applies immediately and survives reload", async ({ page }) => {
    await register(page);
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Dark" }).check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("changing the password signs in with the new one", async ({ page }) => {
    const email = await register(page);
    await page.goto("/settings");
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill("another-long-password-2");
    await page.getByLabel("Confirm new password").fill("another-long-password-2");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("another-long-password-2");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });
});

test.describe("deploys while a tab is open", () => {
  test("a stale lazy chunk (404) makes the app reload itself once and recover", async ({ page }) => {
    await register(page);
    let failures = 0;
    // simulate "the build changed under this tab": the first request for the Send screen's chunk 404s, then it exists again
    await page.route("**/assets/compose-page-*.js", async (route) => {
      if (failures++ === 0) return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      return route.continue();
    });
    await page.getByRole("link", { name: "Send", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Send", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(failures).toBeGreaterThanOrEqual(2); // 1 failed, then the reloaded page fetched it successfully
  });

  test("if the chunk stays broken the user gets a message instead of a reload loop", async ({ page }) => {
    await register(page);
    await page.route("**/assets/emails-page-*.js", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "gone" }));
    await page.getByRole("link", { name: "Emails", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "A new version is available" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  });
});

test.describe("demo mode", () => {
  test("one click creates a working account and a campaign can be watched", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Explore with a demo account" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Demo SMTP (local sink)" })).toBeVisible();

    await page.getByRole("button", { name: "Send 500" }).click();
    await expect(page.getByText("500 emails accepted")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Totals").getByText("500", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("accessibility (axe, WCAG A/AA)", () => {
  const check = async (page: import("@playwright/test").Page, name: string) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target}`);
    expect(summary, `${name}: ${summary.join(" | ")}`).toEqual([]);
  };

  for (const scheme of ["light", "dark"] as const) {
    test(`login and register pages (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" }); // axe samples colours; entrance animations would blend them mid-fade
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
      await check(page, "login");
      await page.goto("/register");
      await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
      await check(page, "register");
    });

    test(`authenticated pages (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" }); // axe samples colours; entrance animations would blend them mid-fade
      await register(page, uniqueEmail("a11y"));
      await addSink(page, { name: "A11y sink" });
      await page.goto("/");
      await expect(page.getByRole("link", { name: "A11y sink" })).toBeVisible();
      await check(page, "dashboard");
      for (const [path, heading] of [
        ["/send", "Send"],
        ["/emails", "Emails"],
        ["/smtp", "SMTP accounts"],
        ["/suppressions", "Suppression list"],
        ["/settings", "Settings"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await check(page, path);
      }
    });
  }
});
