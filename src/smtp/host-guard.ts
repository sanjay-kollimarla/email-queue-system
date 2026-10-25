import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { config } from "../config.ts";

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]!) : false;
}

/**
 * SSRF guard: users supply arbitrary SMTP hosts, and the worker will open sockets to them.
 * Without this, a tenant could point us at 169.254.169.254, redis:6379, mongo:27017, etc.
 * (Does not defend against DNS rebinding between verify and send; pin IPs if you need that.)
 */
export async function assertPublicHost(host: string): Promise<void> {
  if (config.ALLOW_PRIVATE_SMTP_HOSTS) return;
  const addrs = isIPv4(host) || isIPv6(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isIPv4(address) ? isPrivateV4(address) : isPrivateV6(address)) {
      throw new Error(`SMTP host resolves to a private/loopback address (${address})`);
    }
  }
}
