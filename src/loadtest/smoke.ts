/**
 * End-to-end smoke test of the real delivery path against a running stack and the SMTP sink:
 * register -> add SMTP -> send (bulk + attachment + variables) -> verify the RAW message the SMTP server
 * received: headers, MIME attachment, rendered template, one-click unsubscribe, deterministic Message-ID;
 * then POST the unsubscribe and a bounce webhook and verify the API reacts.
 *
 *   bun run smoke -- --sink-host host.docker.internal      (when the workers run in Docker)
 */
export {};

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] ?? def) : def;
};
const API = arg("api", "http://localhost:3100");
const SINK_HTTP = arg("sink-http", "http://localhost:2526");
const SINK_HOST = arg("sink-host", "localhost");

// biome-ignore lint/suspicious/noExplicitAny: a smoke test reads loosely-typed JSON
type Json = Record<string, any>;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, body?: unknown, token?: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

const runId = Math.random().toString(36).slice(2, 8);
const reg = await api("/v1/auth/register", { email: `smoke-${runId}@example.com`, password: "smoke-test-password-1" });
check("register", reg.status === 201, JSON.stringify(reg.json));
const token: string = reg.json.accessToken;

const smtp = await api(
  "/v1/smtp",
  {
    name: "sink",
    host: SINK_HOST,
    port: 2525,
    username: "u",
    password: "p",
    fromEmail: "sender@example.com",
    fromName: "Smoke Sender",
    limits: { perSecond: 50 },
  },
  token,
);
check("smtp account created with a declared rate", smtp.status === 201 && smtp.json.rate.ceilingPerSec === 50, JSON.stringify(smtp.json));
check("smtp response never contains the password", !JSON.stringify(smtp.json).includes('"p"') && smtp.json.passwordEnc === undefined);
check(
  "webhook URL is exposed when PUBLIC_BASE_URL is set",
  typeof smtp.json.webhookUrl === "string" || process.env.EXPECT_NO_WEBHOOK_URL === "1",
  String(smtp.json.webhookUrl),
);

const pdf = Buffer.from("%PDF-1.4 smoke attachment bytes").toString("base64");
const sent = await api(
  "/v1/emails",
  {
    smtpId: smtp.json.id,
    priority: "bulk",
    to: "Reader@Example.com",
    subject: "Hello {{name}}",
    text: "Hi {{name}}, your code is {{code}}",
    html: "<p>Hi <b>{{name}}</b></p>",
    vars: { name: "Ada <script>", code: "42" },
    attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", contentBase64: pdf }],
  },
  token,
);
check("send accepted (202)", sent.status === 202, JSON.stringify(sent.json));

let status = "";
for (let i = 0; i < 40 && status !== "sent"; i++) {
  await sleep(500);
  status = (await api(`/v1/emails/${sent.json.id}`, undefined, token)).json.status;
}
check("email reaches status=sent", status === "sent", status);

const raw = await (await fetch(`${SINK_HTTP}/last`)).text();
// long header values are folded onto continuation lines (RFC 5322): unfold before matching
const msg = (raw.split("\n=====MESSAGE=====\n").find((m) => m.includes(sent.json.id)) ?? "").replace(/\r?\n[ \t]+/g, " ");
check("sink received the message", msg.length > 0);
check("From has the display name", /^From: .*Smoke Sender.*<sender@example\.com>/im.test(msg));
check("subject is rendered", /^Subject: Hello Ada <script>/im.test(msg));
check("html part escapes variables", msg.includes("Ada &lt;script&gt;"));
check("text part is rendered", msg.includes("your code is 42"));
check("deterministic Message-ID", new RegExp(`^Message-ID: <${sent.json.id}@`, "im").test(msg));
check("PDF attachment present", /filename="?invoice\.pdf"?/i.test(msg) && /application\/pdf/i.test(msg));
const unsub = msg.match(/^List-Unsubscribe: <(http[^>]+)>/im)?.[1];
check("bulk mail carries List-Unsubscribe", unsub !== undefined, "set PUBLIC_BASE_URL on the api and workers");
check("one-click post header", /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/im.test(msg));

if (unsub) {
  const url = new URL(unsub);
  const page = await fetch(API + url.pathname);
  check("unsubscribe page confirms without acting", page.status === 200 && (await page.text()).includes("reader@example.com"));
  const done = await fetch(API + url.pathname, { method: "POST", body: "List-Unsubscribe=One-Click" });
  check("one-click unsubscribe works", done.status === 200);
  const again = await api("/v1/emails", { smtpId: smtp.json.id, to: "reader@example.com", subject: "again", text: "x" }, token);
  check("unsubscribed recipient is suppressed on the next send", again.json.status === "suppressed", JSON.stringify(again.json));
}

const hook = smtp.json.webhookUrl as string | undefined;
if (hook) {
  const path = new URL(hook).pathname;
  const second = await api(
    "/v1/emails",
    { smtpId: smtp.json.id, to: "gone@example.com", subject: "s", text: "t", priority: "transactional" },
    token,
  );
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if ((await api(`/v1/emails/${second.json.id}`, undefined, token)).json.status === "sent") break;
  }
  const fb = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ type: "bounce", email: "gone@example.com", reason: "550 5.1.1 unknown user" }] }),
  });
  check("bounce webhook accepted", fb.status === 200);
  const after = await api(`/v1/emails/${second.json.id}`, undefined, token);
  check("email flips to bounced", after.json.status === "bounced", after.json.status);
}

console.log(failures === 0 ? "\nSMOKE TEST: PASS" : `\nSMOKE TEST: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
