import { type ParsedRecipient, isEmail, parseRecipients } from "../../shared/lib/recipients";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH = 1000;

export interface DraftAttachment {
  /** stable identity for list keys (file names may repeat) */
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

export interface Draft {
  mode: "single" | "batch";
  smtpId: string;
  priority: "transactional" | "bulk";
  to: string;
  recipientsText: string;
  subject: string;
  format: "text" | "html";
  body: string;
  attachments: DraftAttachment[];
}

export const emptyDraft = (): Draft => ({
  mode: "single",
  smtpId: "",
  priority: "transactional",
  to: "",
  recipientsText: "",
  subject: "",
  format: "text",
  body: "",
  attachments: [],
});

export interface DraftIssues {
  smtpId?: string;
  to?: string;
  recipients?: string;
  subject?: string;
  body?: string;
  attachments?: string;
}

export interface ValidDraft {
  recipients: ParsedRecipient[];
}

/** Pure validation, mirroring the API's rules so the user fixes problems before a round trip. */
export function validateDraft(d: Draft): { issues: DraftIssues; parsed: ValidDraft } {
  const issues: DraftIssues = {};
  if (!d.smtpId) issues.smtpId = "Choose the SMTP account to send through";

  let recipients: ParsedRecipient[] = [];
  if (d.mode === "single") {
    if (!isEmail(d.to.trim())) issues.to = "Enter a valid recipient address";
    else recipients = [{ to: d.to.trim() }];
  } else {
    const parsed = parseRecipients(d.recipientsText, MAX_BATCH);
    recipients = parsed.recipients;
    if (parsed.recipients.length === 0) issues.recipients = "Add at least one recipient";
    else if (parsed.recipients.length > MAX_BATCH) issues.recipients = `At most ${MAX_BATCH} recipients per batch`;
    else if (parsed.errors.length > 0)
      issues.recipients = `${parsed.errors.length} invalid address${parsed.errors.length > 1 ? "es" : ""}: fix or remove them`;
  }

  if (!d.subject.trim()) issues.subject = "Add a subject";
  else if (d.subject.length > 998) issues.subject = "Subject is too long";
  if (!d.body.trim()) issues.body = "Write the message";
  if (d.attachments.length > MAX_ATTACHMENTS) issues.attachments = `At most ${MAX_ATTACHMENTS} attachments`;
  else if (d.attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENT_BYTES) issues.attachments = "Attachments exceed 8 MB in total";

  return { issues, parsed: { recipients } };
}

export const hasIssues = (i: DraftIssues) => Object.keys(i).length > 0;
