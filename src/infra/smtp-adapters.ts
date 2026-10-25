import type { HostPolicy, SmtpConnectionTester } from "../core/api/ports.ts";
import type { SmtpAccountDoc } from "../db/mongo.ts";
import { assertPublicHost } from "../smtp/host-guard.ts";
import { verifySmtp } from "../smtp/transport.ts";

export class NodemailerConnectionTester implements SmtpConnectionTester {
  verify(account: SmtpAccountDoc): Promise<void> {
    return verifySmtp(account);
  }
}

export class PublicHostPolicy implements HostPolicy {
  assertAllowed(host: string): Promise<void> {
    return assertPublicHost(host);
  }
}
