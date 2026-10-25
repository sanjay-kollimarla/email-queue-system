import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { CredentialsForm } from "../src/features/auth/credentials-form";
import { AccountRate } from "../src/features/dashboard/account-rates";
import { DashboardPage } from "../src/features/dashboard/dashboard-page";
import { findDemoAccount } from "../src/features/demo/demo-panel";
import { ApiError } from "../src/shared/api/http";
import { EMAIL_STATUSES } from "../src/shared/api/schemas";
import { Input } from "../src/shared/ui/field";
import { Meter, Segmented } from "../src/shared/ui/misc";
import { STATUS_META, StatusBadge } from "../src/shared/ui/status-badge";
import { dashboardSnapshot, fakeServices, renderApp, smtpAccount } from "./helpers";

const ANON = { status: "anonymous" } as const;

function SegmentedHarness() {
  const [v, setV] = useState<"a" | "b">("a");
  return (
    <Segmented
      label="Mode"
      value={v}
      onChange={setV}
      options={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
    />
  );
}

describe("form controls are accessible by construction", () => {
  test("Input wires label, hint and error to the control", () => {
    render(<Input label="Email" hint="We never share it" error="Enter a valid email" required />);
    const input = screen.getByLabelText(/Email/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(screen.getByRole("alert").textContent).toBe("Enter a valid email");
    expect(screen.queryByText("We never share it")).toBeNull(); // the hint yields to the error
  });

  test("Input without an error shows its hint and is not marked invalid", () => {
    render(<Input label="Name" hint="Shown on invoices" />);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("Shown on invoices")).toBeTruthy();
  });

  test("Segmented is a radio group and reports changes", async () => {
    render(<SegmentedHarness />);
    const beta = screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement;
    expect((screen.getByRole("radio", { name: "Alpha" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(beta);
    await waitFor(() => expect(beta.checked).toBe(true));
  });

  test("Meter exposes its value to assistive technology and clamps", () => {
    render(<Meter value={150} max={100} label="Send rate" />);
    const m = screen.getByRole("meter", { name: "Send rate" });
    expect(m.getAttribute("aria-valuemax")).toBe("100");
    expect((m.firstElementChild as HTMLElement).style.width).toBe("100%");
  });
});

describe("StatusBadge", () => {
  test.each(EMAIL_STATUSES)("%s has a text label (colour is never the only signal)", (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(STATUS_META[status].label)).toBeTruthy();
  });
});

describe("sign in form", () => {
  const users = (login: () => Promise<unknown>) =>
    fakeServices({
      meta: async () => ({ demo: false, version: "1" }),
      auth: { login: login as never, me: async () => ({ id: "u1", email: "me@x.co", createdAt: "2026-01-01" }) },
    });

  test("client-side validation blocks the request and explains why", async () => {
    let calls = 0;
    renderApp(
      <CredentialsForm mode="login" />,
      users(async () => void calls++),
      { auth: ANON },
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address")).toBeTruthy();
    expect(screen.getByText("Enter your password")).toBeTruthy();
    expect(calls).toBe(0);
  });

  test("wrong credentials show one clear message, not the raw server text", async () => {
    renderApp(
      <CredentialsForm mode="login" />,
      users(async () => Promise.reject(new ApiError(401, "invalid credentials"))),
      { auth: ANON },
    );
    await userEvent.type(screen.getByLabelText("Email"), "me@x.co");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect email or password");
  });

  test("rate limiting is explained", async () => {
    renderApp(
      <CredentialsForm mode="login" />,
      users(async () => Promise.reject(new ApiError(429, "too many requests"))),
      { auth: ANON },
    );
    await userEvent.type(screen.getByLabelText("Email"), "me@x.co");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
  });

  test("a network failure never leaks a stack trace", async () => {
    renderApp(
      <CredentialsForm mode="login" />,
      users(async () => Promise.reject(new TypeError("Failed to fetch"))),
      { auth: ANON },
    );
    await userEvent.type(screen.getByLabelText("Email"), "me@x.co");
    await userEvent.type(screen.getByLabelText("Password"), "whatever-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the server");
  });

  test("register mode enforces the 10-character rule and maps 409 to the email field", async () => {
    const services = fakeServices({
      meta: async () => ({ demo: false, version: "1" }),
      auth: { register: async () => Promise.reject(new ApiError(409, "email already registered")) },
    });
    renderApp(<CredentialsForm mode="register" />, services, { auth: ANON });
    await userEvent.type(screen.getByLabelText("Email"), "me@x.co");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Use at least 10 characters")).toBeTruthy();

    await userEvent.clear(screen.getByLabelText("Password"));
    await userEvent.type(screen.getByLabelText("Password"), "long-enough-password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("An account with this email already exists")).toBeTruthy();
  });

  test("the demo button only exists when the server is in demo mode", async () => {
    const off = renderApp(<CredentialsForm mode="login" />, fakeServices({ meta: async () => ({ demo: false, version: "1" }) }), {
      auth: ANON,
    });
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Explore with a demo account" })).toBeNull();
    off.unmount();
    renderApp(<CredentialsForm mode="login" />, fakeServices({ meta: async () => ({ demo: true, version: "1" }) }), { auth: ANON });
    expect(await screen.findByRole("button", { name: "Explore with a demo account" })).toBeTruthy();
  });
});

describe("account rate panel (the adaptive controller, visualised)", () => {
  const rate = (over: object) => ({
    declared: { perSecond: 10 },
    ceilingPerSec: 10,
    dailyCap: 500,
    currentPerSec: 4,
    learnedLimitPerSec: null,
    pausedUntil: null,
    ...over,
  });

  test("healthy: shows current vs declared ceiling and that nothing was learned yet", () => {
    renderApp(
      <ul>
        <AccountRate account={smtpAccount({ rate: rate({}) })} />
      </ul>,
      fakeServices({}),
    );
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("4/s")).toBeTruthy();
    expect(screen.getByText(/of 10\/s allowed/)).toBeTruthy();
    expect(screen.getByText("not throttled yet")).toBeTruthy();
    expect(screen.getByText("500")).toBeTruthy();
  });

  test("shows the provider limit the controller learned and marks it on the bar", () => {
    renderApp(
      <ul>
        <AccountRate account={smtpAccount({ rate: rate({ learnedLimitPerSec: 6.5 }) })} />
      </ul>,
      fakeServices({}),
    );
    expect(screen.getByText("6.50/s")).toBeTruthy();
    expect(document.querySelector('[title="Learned provider limit: 6.50/s"]')).not.toBeNull();
  });

  test("paused accounts show a countdown and a zero rate", () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    renderApp(
      <ul>
        <AccountRate account={smtpAccount({ rate: rate({ pausedUntil: until }) })} />
      </ul>,
      fakeServices({}),
    );
    expect(screen.getByText(/Paused 1m/)).toBeTruthy();
    expect(screen.getByText("0/s")).toBeTruthy();
  });

  test("rejected credentials are called out with the server's detail", () => {
    renderApp(
      <ul>
        <AccountRate account={smtpAccount({ health: "auth_failed", healthDetail: "535 bad login", rate: rate({}) })} />
      </ul>,
      fakeServices({}),
    );
    expect(screen.getByText("Credentials rejected")).toBeTruthy();
    expect(screen.getByText("535 bad login")).toBeTruthy();
  });
});

describe("dashboard", () => {
  const services = (dash: ReturnType<typeof dashboardSnapshot>) =>
    fakeServices(
      {
        meta: async () => ({ demo: false, version: "1" }),
        dashboard: { get: async () => dash },
        auth: { me: async () => ({ id: "u1", email: "me@x.co", createdAt: "2026-01-01" }) },
      },
      { sessionAlive: true },
    );

  test("renders the totals, pipeline, problems and the rate state from one snapshot", async () => {
    renderApp(<DashboardPage />, services(dashboardSnapshot()));
    expect(await screen.findByText("Pipeline")).toBeTruthy();
    const totals = screen.getByLabelText("Totals");
    expect(within(totals).getByText("1,200")).toBeTruthy(); // delivered
    expect(within(totals).getByText("45")).toBeTruthy(); // queued + sending
    expect(screen.getByText("gone@example.com")).toBeTruthy();
    expect(screen.getByText("550 5.1.1 no such user")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Emails sent per second/ })).toBeTruthy();
    expect(screen.getByText("Company Gmail")).toBeTruthy();
  });

  test("a brand new account is guided to add an SMTP account instead of showing empty charts", async () => {
    renderApp(
      <DashboardPage />,
      services(
        dashboardSnapshot({
          accounts: [],
          total: 0,
          problems: [],
          counts: { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, bounced: 0, complained: 0 },
        }),
      ),
    );
    expect(await screen.findByText("Connect your SMTP account to start")).toBeTruthy();
    expect(screen.queryByText("Pipeline")).toBeNull();
  });

  test("no problems shows a calm message", async () => {
    renderApp(<DashboardPage />, services(dashboardSnapshot({ problems: [] })));
    expect(await screen.findByText(/Nothing went wrong/)).toBeTruthy();
  });
});

describe("demo campaign safety", () => {
  const sink = smtpAccount({ id: "s".repeat(24), name: "Demo SMTP (local sink)", host: "localhost", port: 2525 });
  const real = smtpAccount({ id: "r".repeat(24), name: "Company Gmail", host: "smtp.gmail.com", port: 587 });

  test("only the account that points at the bundled fake SMTP server is eligible", () => {
    expect(findDemoAccount([real, sink], { host: "localhost", port: 2525 })?.id).toBe(sink.id);
  });

  test("a real SMTP account is never eligible, even when it is the only one", () => {
    expect(findDemoAccount([real], { host: "localhost", port: 2525 })).toBeUndefined();
  });

  test("outside demo mode nothing is eligible", () => {
    expect(findDemoAccount([sink, real], undefined)).toBeUndefined();
  });

  test("host comparison is case-insensitive but the port must match", () => {
    expect(findDemoAccount([smtpAccount({ host: "LocalHost", port: 2525 })], { host: "localhost", port: 2525 })).toBeDefined();
    expect(findDemoAccount([smtpAccount({ host: "localhost", port: 587 })], { host: "localhost", port: 2525 })).toBeUndefined();
  });
});
