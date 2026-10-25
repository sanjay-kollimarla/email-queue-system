import { z } from "zod";
import type { HttpClient } from "./http";
import {
  accepted,
  authResult,
  batchAccepted,
  dashboard,
  type EmailStatus,
  emailPage,
  type Limits,
  me,
  meta,
  ok,
  smtpAccount,
  smtpHint,
  smtpList,
  statusCounts,
  suppressionList,
} from "./schemas";

export interface Credentials {
  email: string;
  password: string;
}

export interface NewSmtpAccount {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
  limits: Limits;
  maxConnections: number;
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface SendInput {
  smtpId?: string;
  priority: "transactional" | "bulk";
  subject: string;
  text?: string;
  html?: string;
  attachments?: AttachmentInput[];
}

/**
 * The typed gateway to the backend: one function per endpoint, each with its response schema.
 * Components never build URLs or parse JSON; they call `useApi().emails.list(...)`, which keeps the HTTP
 * details replaceable (and the UI testable with a fake) without touching any screen.
 */
export function createApi(http: HttpClient) {
  const idem = (key?: string) => (key ? { "idempotency-key": key } : undefined);

  return {
    meta: () => http.request("/v1/meta", { schema: meta, auth: false }),

    auth: {
      login: (c: Credentials) => http.request("/v1/auth/login", { body: c, schema: authResult, auth: false }),
      register: (c: Credentials) => http.request("/v1/auth/register", { body: c, schema: authResult, auth: false }),
      logout: () => http.request("/v1/auth/logout", { method: "POST", schema: ok, auth: false }),
      me: () => http.request("/v1/auth/me", { schema: me }),
      changePassword: (currentPassword: string, newPassword: string) =>
        http.request("/v1/auth/change-password", { body: { currentPassword, newPassword }, schema: authResult }),
    },

    dashboard: {
      get: (signal?: AbortSignal) => http.request("/v1/dashboard", { schema: dashboard, signal }),
    },

    smtp: {
      list: () => http.request("/v1/smtp", { schema: smtpList }),
      create: (a: NewSmtpAccount) => http.request("/v1/smtp", { body: a, schema: smtpAccount }),
      update: (id: string, patch: Partial<NewSmtpAccount>) =>
        http.request(`/v1/smtp/${id}`, { method: "PATCH", body: patch, schema: smtpAccount }),
      verify: (id: string) => http.request(`/v1/smtp/${id}/verify`, { method: "POST", schema: ok }),
      remove: (id: string) => http.request(`/v1/smtp/${id}`, { method: "DELETE", schema: ok }),
      hints: (host: string, signal?: AbortSignal) =>
        http.request(`/v1/smtp/hints?host=${encodeURIComponent(host)}`, { schema: smtpHint, signal }),
    },

    emails: {
      list: (params: { status?: EmailStatus; before?: string; limit?: number }) => {
        const q = new URLSearchParams();
        if (params.status) q.set("status", params.status);
        if (params.before) q.set("before", params.before);
        if (params.limit) q.set("limit", String(params.limit));
        return http.request(`/v1/emails?${q}`, { schema: emailPage });
      },
      sendOne: (input: SendInput & { to: string; vars?: Record<string, string> }, idempotencyKey?: string) =>
        http.request("/v1/emails", { body: input, schema: accepted, headers: idem(idempotencyKey) }),
      sendBatch: (input: SendInput & { recipients: Array<{ to: string; vars?: Record<string, string> }> }, idempotencyKey?: string) =>
        http.request("/v1/emails/batch", { body: input, schema: batchAccepted, headers: idem(idempotencyKey) }),
      stats: () => http.request("/v1/stats", { schema: z.object({ counts: statusCounts, total: z.number() }) }),
    },

    suppressions: {
      list: () => http.request("/v1/suppressions", { schema: suppressionList }),
      add: (email: string, reason: string) => http.request("/v1/suppressions", { body: { email, reason }, schema: ok }),
      remove: (email: string) => http.request(`/v1/suppressions/${encodeURIComponent(email)}`, { method: "DELETE", schema: ok }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
