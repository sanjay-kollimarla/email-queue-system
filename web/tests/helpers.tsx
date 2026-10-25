import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { ServicesProvider, type Services } from "../src/app/services";
import { AuthProvider, type AuthState } from "../src/features/auth/auth-context";
import type { Api } from "../src/shared/api/endpoints";
import { MemoryTokenStore } from "../src/shared/api/http";
import type { Dashboard, SmtpAccount } from "../src/shared/api/schemas";
import { ThemeProvider } from "../src/shared/theme/theme";
import { ToastProvider } from "../src/shared/ui/toast";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...a: never[]) => unknown ? T[K] : DeepPartial<T[K]> };

/** A Services bundle whose API is a plain object the test controls; anything not provided throws when called. */
export function fakeServices(api: DeepPartial<Api>, opts: { sessionAlive?: boolean } = {}): Services {
  const handler = (path: string): ProxyHandler<object> => ({
    get(target, prop) {
      const v = (target as Record<string, unknown>)[prop as string];
      if (v !== undefined) return v;
      return () => {
        throw new Error(`unexpected API call: ${path}.${String(prop)}`);
      };
    },
  });
  const proxied = Object.fromEntries(
    Object.entries(api).map(([group, impl]) => [group, typeof impl === "function" ? impl : new Proxy(impl as object, handler(group))]),
  );
  const tokens = new MemoryTokenStore();
  return {
    api: proxied as unknown as Api,
    tokens,
    http: { refresh: async () => opts.sessionAlive ?? false } as unknown as Services["http"],
    sessionHandlers: { onLost: () => {} },
  };
}

const SIGNED_IN: AuthState = { status: "authenticated", user: { id: "u1", email: "me@x.co" } };

/** Renders with providers; signed in by default (pass `auth: { status: "anonymous" }` for login screens). */
export function renderApp(ui: ReactElement, services: Services, opts: { route?: string; auth?: AuthState } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(
    <ThemeProvider>
      <ServicesProvider services={services}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <MemoryRouter initialEntries={[opts.route ?? "/"]}>
              <AuthProvider initialState={opts.auth ?? SIGNED_IN}>{ui}</AuthProvider>
            </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>
      </ServicesProvider>
    </ThemeProvider>,
  );
}

export const smtpAccount = (over: Partial<SmtpAccount> = {}): SmtpAccount => ({
  id: "a".repeat(24),
  name: "Company Gmail",
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  username: "me",
  fromEmail: "me@company.com",
  provider: "gmail",
  maxConnections: 5,
  health: "ok",
  createdAt: "2026-01-01T00:00:00.000Z",
  rate: { declared: { perSecond: 10 }, ceilingPerSec: 10, dailyCap: 500, currentPerSec: 4, learnedRateLimitPerSec: null } as never,
  ...over,
});

export function dashboardSnapshot(over: Partial<Dashboard> = {}): Dashboard {
  const now = Date.parse("2026-01-01T12:00:00Z");
  return {
    now: new Date(now).toISOString(),
    counts: { queued: 40, sending: 5, sent: 1200, failed: 3, suppressed: 2, bounced: 1, complained: 0 },
    total: 1251,
    throughput: {
      bucketSec: 10,
      points: Array.from({ length: 31 }, (_, i) => ({ at: new Date(now - (30 - i) * 10_000).toISOString(), sent: i % 5 === 0 ? 0 : 30 })),
      sentPerSecNow: 3,
      peakPerSec: 3,
    },
    accounts: [
      smtpAccount({
        rate: {
          declared: { perSecond: 10 },
          ceilingPerSec: 10,
          dailyCap: 500,
          currentPerSec: 4,
          learnedLimitPerSec: 6.5,
          pausedUntil: null,
        },
      }),
    ],
    problems: [{ id: "p1", to: "gone@example.com", status: "bounced", reason: "550 5.1.1 no such user", at: new Date(now).toISOString() }],
    ...over,
  };
}
