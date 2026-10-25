import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ApiError, type FetchFn, HttpClient, MemoryTokenStore } from "../src/shared/api/http";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const tokens = new MemoryTokenStore();
  let lost = 0;
  const fetchFn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  const http = new HttpClient({ fetch: fetchFn, tokens, onSessionLost: () => void lost++ });
  return { http, calls, tokens, lost: () => lost };
}

/** Awaits a promise that must reject and returns the ApiError. */
const rejection = (p: Promise<unknown>): Promise<ApiError> =>
  p.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (e: unknown) => e as ApiError,
  );

const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe("HttpClient", () => {
  test("attaches the in-memory token and validates the response against its schema", async () => {
    const { http, tokens, calls } = setup(() => json(200, { n: 1 }));
    tokens.set("abc");
    const r = await http.request("/v1/x", { schema: z.object({ n: z.number() }) });
    expect(r.n).toBe(1);
    expect(authHeader(calls[0]!.init)).toBe("Bearer abc");
    expect((calls[0]!.init.headers as Record<string, string>)["x-client"]).toBe("web");
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  test("auth: false requests never carry a token", async () => {
    const { http, tokens, calls } = setup(() => json(200, {}));
    tokens.set("abc");
    await http.request("/v1/meta", { auth: false });
    expect(authHeader(calls[0]!.init)).toBeUndefined();
  });

  test("a response that breaks the contract becomes a 502 ApiError (and is logged for developers), never undefined data", async () => {
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args); // captured instead of printed
    try {
      const { http } = setup(() => json(200, { n: "not a number" }));
      const err = await rejection(http.request("/v1/x", { schema: z.object({ n: z.number() }) }));
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(502);
      expect(err.message).toBe("The server sent an unexpected response.");
      expect(String(logged[0]?.[0])).toContain("did not match the contract");
    } finally {
      console.error = original;
    }
  });

  test("401 -> one refresh -> the original request is retried with the new token", async () => {
    const { http, tokens, calls } = setup((url, init) => {
      if (url === "/v1/auth/refresh") return json(200, { accessToken: "fresh" });
      return authHeader(init) === "Bearer fresh" ? json(200, { ok: true }) : json(401, { error: "invalid or expired token" });
    });
    tokens.set("stale");
    const r = await http.request("/v1/things", { schema: z.object({ ok: z.boolean() }) });
    expect(r.ok).toBe(true);
    expect(tokens.get()).toBe("fresh");
    expect(calls.map((c) => c.url)).toEqual(["/v1/things", "/v1/auth/refresh", "/v1/things"]);
  });

  test("parallel 401s share ONE refresh call (single-flight)", async () => {
    let refreshes = 0;
    const { http, tokens } = setup(async (url, init) => {
      if (url === "/v1/auth/refresh") {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { accessToken: "fresh" });
      }
      return authHeader(init) === "Bearer fresh" ? json(200, { ok: true }) : json(401, { error: "expired" });
    });
    tokens.set("stale");
    await Promise.all(Array.from({ length: 8 }, () => http.request("/v1/things")));
    expect(refreshes).toBe(1);
  });

  test("when the refresh is rejected the session is reported lost, once, and the token cleared", async () => {
    const { http, tokens, lost } = setup((url) =>
      url === "/v1/auth/refresh" ? json(401, { error: "invalid refresh token" }) : json(401, { error: "expired" }),
    );
    tokens.set("stale");
    const err = await rejection(http.request("/v1/things"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isAuth).toBe(true);
    expect(tokens.get()).toBeNull();
    expect(lost()).toBe(1);
  });

  test("a 401 on an unauthenticated call (bad login) is just an error, with no refresh attempt", async () => {
    const { http, calls } = setup(() => json(401, { error: "invalid credentials" }));
    const err = await rejection(http.request("/v1/auth/login", { body: { a: 1 }, auth: false }));
    expect(err.message).toBe("invalid credentials");
    expect(calls).toHaveLength(1);
  });

  test("validation errors surface the first field message", async () => {
    const { http } = setup(() =>
      json(422, { error: "validation failed", details: { formErrors: [], fieldErrors: { email: ["invalid email address"] } } }),
    );
    const err = await rejection(http.request("/v1/x", { body: {} }));
    expect(err.status).toBe(422);
    expect(err.message).toBe("email: invalid email address");
    expect(err.fieldErrors.email).toEqual(["invalid email address"]);
  });

  test("other statuses keep the server's message; non-JSON failures get a generic one", async () => {
    expect(
      await setup(() => json(409, { error: "limit of 20 smtp accounts reached" }))
        .http.request("/v1/x", { body: {} })
        .then(
          () => "resolved",
          (e: ApiError) => e.message,
        ),
    ).toBe("limit of 20 smtp accounts reached");
    expect(
      await setup(() => new Response("<html>bad gateway</html>", { status: 502 }))
        .http.request("/v1/x")
        .then(
          () => "resolved",
          (e: ApiError) => e.message,
        ),
    ).toBe("Request failed (502)");
    const limited = await rejection(setup(() => json(429, { error: "too many requests, slow down" })).http.request("/v1/x"));
    expect(limited.isRateLimited).toBe(true);
  });

  test("sends JSON bodies with a content type and idempotency headers", async () => {
    const { http, calls } = setup(() => json(200, {}));
    await http.request("/v1/emails", { body: { to: "a@b.co" }, headers: { "idempotency-key": "k1" } });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["idempotency-key"]).toBe("k1");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"to":"a@b.co"}');
  });
});
