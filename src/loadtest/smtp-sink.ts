/**
 * A fake SMTP server for load/chaos testing. Accepts any AUTH and any message, and can:
 *   - add artificial latency per message             SINK_LATENCY_MS (+/- SINK_JITTER_MS), changeable live
 *   - report CONCURRENCY actually used               peakInflight / peakConnections (proves the connection cap)
 *   - emulate a provider rate limit (451 4.7.1)      SINK_LIMIT_PER_SEC   <- proves the adaptive controller
 *   - count unique messages and DUPLICATES           (by the X-Email-Id header)
 *
 * It is a ~100-line raw-socket SMTP responder rather than a full server library, because the
 * library topped out near 3k msgs/s and would have been the benchmark's bottleneck instead of the
 * system under test.
 *
 * Live control + stats over HTTP on SINK_HTTP_PORT:
 *   GET  /stats
 *   GET  /last                           raw text of the last 5 messages received
 *   POST /config?limit=20&latency=3000&jitter=1000     POST /reset
 */
const smtpPort = Number(process.env.SINK_PORT ?? 2525);
const httpPort = Number(process.env.SINK_HTTP_PORT ?? 2526);
let limitPerSec = Number(process.env.SINK_LIMIT_PER_SEC ?? 0); // 0 = unlimited
let latencyMs = Number(process.env.SINK_LATENCY_MS ?? 0);
let jitterMs = Number(process.env.SINK_JITTER_MS ?? 0);

const seen = new Set<string>();
const recent: string[] = []; // last few raw messages, for smoke tests (GET /last)
const counters = { accepted: 0, unique: 0, duplicates: 0, rateLimited: 0, connections: 0 };
let windowStart = 0;
let windowCount = 0;
const perSec: number[] = [];
let inflight = 0; // messages whose SMTP answer is still being delayed
let peakInflight = 0;
let openConnections = 0;
let peakConnections = 0;
let currentSecondAccepted = 0;

function overLimit(): boolean {
  if (limitPerSec <= 0) return false;
  const now = Date.now();
  if (now - windowStart >= 1000) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount > limitPerSec;
}

interface Conn {
  mode: "cmd" | "data";
  buf: string;
}
type Sock = Bun.Socket<Conn>;

/** One message's processing time: the configured latency, randomised by +/- jitter. */
const delayMs = () => Math.max(0, latencyMs + (jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0));

function endOfData(s: Sock, message: string) {
  inflight++;
  peakInflight = Math.max(peakInflight, inflight);
  setTimeout(() => {
    inflight--;
    finish(s, message);
  }, delayMs());
}

function finish(s: Sock, message: string) {
  if (overLimit()) {
    counters.rateLimited++;
    s.write("451 4.7.1 Rate limit exceeded, try again later\r\n");
    return;
  }
  counters.accepted++;
  currentSecondAccepted++;
  recent.push(message.slice(0, 400_000));
  if (recent.length > 5) recent.shift();
  const id = message.match(/^X-Email-Id:[ \t]*(\S+)/im)?.[1];
  if (id) {
    if (seen.has(id)) counters.duplicates++;
    else {
      seen.add(id);
      counters.unique++;
    }
  }
  s.write("250 2.0.0 OK queued as sink\r\n");
}

function pump(s: Sock) {
  const c = s.data;
  for (;;) {
    if (c.mode === "data") {
      const end = c.buf.startsWith(".\r\n") ? 0 : c.buf.indexOf("\r\n.\r\n");
      if (end < 0) return;
      const message = c.buf.slice(0, end);
      c.buf = c.buf.slice(end === 0 ? 3 : end + 5);
      c.mode = "cmd";
      endOfData(s, message);
      continue;
    }
    const eol = c.buf.indexOf("\r\n");
    if (eol < 0) return;
    const line = c.buf.slice(0, eol);
    c.buf = c.buf.slice(eol + 2);
    const cmd = line.slice(0, 4).toUpperCase();
    if (cmd === "EHLO") s.write("250-sink\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
    else if (cmd === "HELO") s.write("250 sink\r\n");
    else if (cmd === "AUTH") s.write("235 2.7.0 Authentication successful\r\n");
    else if (cmd === "DATA") {
      c.mode = "data";
      s.write("354 End data with <CR><LF>.<CR><LF>\r\n");
    } else if (cmd === "QUIT") {
      s.write("221 Bye\r\n");
      s.end();
      return;
    } else if (cmd === "MAIL" || cmd === "RCPT" || cmd === "RSET" || cmd === "NOOP") s.write("250 OK\r\n");
    else s.write("502 5.5.2 Command not recognized\r\n");
  }
}

Bun.listen<Conn>({
  hostname: "0.0.0.0",
  port: smtpPort,
  socket: {
    open(s) {
      counters.connections++;
      openConnections++;
      peakConnections = Math.max(peakConnections, openConnections);
      s.data = { mode: "cmd", buf: "" };
      s.write("220 sink ESMTP ready\r\n");
    },
    data(s, chunk) {
      s.data.buf += chunk.toString("latin1");
      pump(s);
    },
    close() {
      openConnections--;
    },
    error() {},
  },
});
console.log(`[sink] SMTP listening on :${smtpPort} (limit=${limitPerSec || "none"}/s latency=${latencyMs}ms jitter=${jitterMs}ms)`);

setInterval(() => {
  perSec.push(currentSecondAccepted);
  if (perSec.length > 3600) perSec.shift();
  if (currentSecondAccepted > 0) {
    console.log(
      `[sink] accepted ${currentSecondAccepted}/s total=${counters.accepted} 451s=${counters.rateLimited} dup=${counters.duplicates}`,
    );
  }
  currentSecondAccepted = 0;
}, 1000);

Bun.serve({
  port: httpPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/stats") {
      return Response.json({
        ...counters,
        limitPerSec,
        latencyMs,
        jitterMs,
        inflight,
        peakInflight,
        openConnections,
        peakConnections,
        peakPerSec: Math.max(0, ...perSec),
      });
    }
    if (url.pathname === "/last") {
      return new Response(recent.join("\n=====MESSAGE=====\n"), { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/config" && req.method === "POST") {
      if (url.searchParams.has("limit")) limitPerSec = Number(url.searchParams.get("limit"));
      if (url.searchParams.has("latency")) latencyMs = Number(url.searchParams.get("latency"));
      if (url.searchParams.has("jitter")) jitterMs = Number(url.searchParams.get("jitter"));
      return Response.json({ limitPerSec, latencyMs, jitterMs });
    }
    if (url.pathname === "/reset" && req.method === "POST") {
      seen.clear();
      Object.assign(counters, { accepted: 0, unique: 0, duplicates: 0, rateLimited: 0, connections: 0 });
      perSec.length = 0;
      peakInflight = inflight;
      peakConnections = openConnections;
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`[sink] control/stats on http://localhost:${httpPort}/stats`);
