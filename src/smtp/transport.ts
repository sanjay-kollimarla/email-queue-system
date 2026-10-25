import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";
import { decrypt } from "../lib/crypto.ts";
import type { SmtpAccountDoc } from "../db/mongo.ts";

interface Entry {
  transport: Transporter;
  fingerprint: string;
  lastUsed: number;
}

const MAX_ENTRIES = 500;
const cache = new Map<string, Entry>();

function baseOptions(a: SmtpAccountDoc) {
  return {
    host: a.host,
    port: a.port,
    secure: a.secure,
    auth: { user: a.username, pass: decrypt(a.passwordEnc) },
    requireTLS: !a.secure && !config.ALLOW_PRIVATE_SMTP_HOSTS,
    tls: { minVersion: "TLSv1.2" as const },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

const fingerprintOf = (a: SmtpAccountDoc) => [a.host, a.port, a.secure, a.username, a.passwordEnc, a.maxConnections].join("|");

/**
 * One pooled transporter per SMTP account, reused across jobs (connection reuse is the single
 * biggest throughput win: no TCP+TLS+AUTH handshake per email). The fingerprint busts the cache
 * when the user edits credentials.
 */
export function getTransport(a: SmtpAccountDoc): Transporter {
  const id = String(a._id);
  const fp = fingerprintOf(a);
  const hit = cache.get(id);
  if (hit && hit.fingerprint === fp) {
    hit.lastUsed = Date.now();
    return hit.transport;
  }
  hit?.transport.close();

  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((x, y) => x[1].lastUsed - y[1].lastUsed)[0];
    if (oldest) {
      oldest[1].transport.close();
      cache.delete(oldest[0]);
    }
  }
  const transport = nodemailer.createTransport({
    ...baseOptions(a),
    pool: true,
    maxConnections: a.maxConnections,
    maxMessages: 500, // recycle a connection after N messages (providers often cap per-connection)
  });
  cache.set(id, { transport, fingerprint: fp, lastUsed: Date.now() });
  return transport;
}

export function closeAllTransports() {
  for (const e of cache.values()) e.transport.close();
  cache.clear();
}

/** One-off, non-pooled connection test used when saving credentials. */
export async function verifySmtp(a: SmtpAccountDoc): Promise<void> {
  const t = nodemailer.createTransport(baseOptions(a));
  try {
    await t.verify();
  } finally {
    t.close();
  }
}
