import type { DeliveryReceipt, Mailer, OutgoingMail } from "../core/ports.ts";
import type { SmtpAccountDoc } from "../db/mongo.ts";
import { getTransport } from "../smtp/transport.ts";

/** Mailer adapter: one pooled Nodemailer transport per SMTP account (see smtp/transport.ts). */
export class NodemailerMailer implements Mailer {
  async send(smtp: SmtpAccountDoc, mail: OutgoingMail): Promise<DeliveryReceipt> {
    const info = await getTransport(smtp).sendMail({
      from: smtp.fromName ? { name: smtp.fromName, address: smtp.fromEmail } : smtp.fromEmail,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId: mail.messageId,
      attachments: mail.attachments,
      headers: { ...mail.headers, "X-Email-Id": mail.emailId },
    });
    return { response: info.response ?? "ok", rejected: (info.rejected ?? []).map(String) };
  }
}
