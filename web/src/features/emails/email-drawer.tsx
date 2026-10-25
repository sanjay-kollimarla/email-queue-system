import type { ReactNode } from "react";
import type { Email } from "../../shared/api/schemas";
import { formatDateTime } from "../../shared/lib/format";
import { Dialog } from "../../shared/ui/dialog";
import { CopyButton } from "../../shared/ui/misc";
import { STATUS_META, StatusBadge } from "../../shared/ui/status-badge";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-b border-line py-3 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function EmailDrawer({ email, onClose }: { email: Email | null; onClose: () => void }) {
  return (
    <Dialog open={email !== null} onClose={onClose} title="Email details" variant="drawer">
      {email && (
        <>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="truncate text-lg font-semibold">{email.to}</span>
            <StatusBadge status={email.status} />
          </div>
          <p className="mb-4 text-sm text-muted">{STATUS_META[email.status].hint}.</p>
          <dl>
            <Row label="Email ID">
              <span className="flex items-center justify-between gap-2">
                <code className="text-xs">{email.id}</code>
                <CopyButton value={email.id} />
              </span>
            </Row>
            <Row label="Message-ID">
              <code className="text-xs">{email.messageId}</code>
            </Row>
            <Row label="Priority">
              <span className="capitalize">{email.priority}</span>
            </Row>
            <Row label="Attempts">{email.attempts}</Row>
            <Row label="Accepted">{formatDateTime(email.createdAt)}</Row>
            {email.sentAt && <Row label="Handed to SMTP">{formatDateTime(email.sentAt)}</Row>}
            {email.response && (
              <Row label="SMTP response">
                <code className="text-xs">{email.response}</code>
              </Row>
            )}
            {email.lastError && (
              <Row label="Last error">
                <span className="text-bad">{email.lastError}</span>
              </Row>
            )}
          </dl>
        </>
      )}
    </Dialog>
  );
}
