import type { z } from "zod";

/** Normalised failure from the API (or from a response that violates the contract). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuth() {
    return this.status === 401;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

/** In-memory only: an access token that never touches localStorage cannot be read by injected scripts later. */
export class MemoryTokenStore implements TokenStore {
  private token: string | null = null;
  get() {
    return this.token;
  }
  set(token: string | null) {
    this.token = token;
  }
}

export interface RequestOptions<S extends z.ZodType> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** validates (and types) the response; omit for endpoints whose body we ignore */
  schema?: S;
  /** attach the access token and transparently refresh it on 401 (default true) */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** The subset of `fetch` we use: lets tests pass a plain function (no `preconnect` etc.). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientDeps {
  fetch: FetchFn;
  tokens: TokenStore;
  /** called once when the session cannot be renewed (refresh rejected): the app should show the login screen */
  onSessionLost: () => void;
}

/**
 * The only place that talks HTTP. Responsibilities, in order of the request:
 *   1. attach the in-memory access token
 *   2. on 401, renew the session ONCE (single-flight: ten parallel requests share one refresh call), then retry
 *   3. turn failures into ApiError with field-level messages the forms can show
 *   4. validate the success body against its zod schema
 * Everything else (caching, polling, retries) belongs to TanStack Query one layer up.
 */
export class HttpClient {
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly deps: HttpClientDeps) {}

  async request<S extends z.ZodType>(path: string, opts: RequestOptions<S> = {}): Promise<S extends z.ZodType ? z.infer<S> : unknown> {
    const auth = opts.auth ?? true;
    let res = await this.send(path, opts, auth);

    if (res.status === 401 && auth) {
      if (await this.refresh()) res = await this.send(path, opts, auth);
      else throw new ApiError(401, "Your session has expired. Please sign in again.");
    }
    return this.parse(res, opts.schema) as S extends z.ZodType ? z.infer<S> : unknown;
  }

  /** Renew the access token using the HttpOnly refresh cookie. Resolves true when a new token is in place. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const res = await this.deps.fetch("/v1/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-client": "web" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { accessToken?: string };
      if (!body.accessToken) throw new Error("no token");
      this.deps.tokens.set(body.accessToken);
      return true;
    } catch {
      this.deps.tokens.set(null);
      this.deps.onSessionLost();
      return false;
    }
  }

  private send(path: string, opts: RequestOptions<z.ZodType>, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = { "x-client": "web", ...opts.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const token = this.deps.tokens.get();
    if (auth && token) headers.authorization = `Bearer ${token}`;
    return this.deps.fetch(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      credentials: "same-origin",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  }

  private async parse<S extends z.ZodType>(res: Response, schema: S | undefined): Promise<unknown> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) throw toApiError(res.status, json);
    if (!schema) return json;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      console.error("API response did not match the contract", parsed.error.issues);
      throw new ApiError(502, "The server sent an unexpected response.");
    }
    return parsed.data;
  }
}

/** Server shape: { error, details?: { formErrors: string[], fieldErrors: { field: string[] } } } */
function toApiError(status: number, json: unknown): ApiError {
  const body = (json ?? {}) as { error?: string; details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } };
  const fieldErrors = body.details?.fieldErrors ?? {};
  const first = Object.entries(fieldErrors)[0];
  const detail = body.details?.formErrors?.[0] ?? (first ? `${first[0]}: ${first[1]?.[0]}` : undefined);
  const base = body.error ?? `Request failed (${status})`;
  const message = status === 422 && detail && base === "validation failed" ? detail : base;
  return new ApiError(status, message, fieldErrors);
}
