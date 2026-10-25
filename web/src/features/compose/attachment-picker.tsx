import { Paperclip, X } from "lucide-react";
import { useRef } from "react";
import { formatBytes } from "../../shared/lib/format";
import { Button } from "../../shared/ui/button";
import { type DraftAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./draft";

/** File -> base64 without loading the whole thing through string concatenation of bytes. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function AttachmentPicker({
  value,
  onChange,
  error,
}: {
  value: DraftAttachment[];
  onChange: (next: DraftAttachment[]) => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const used = value.reduce((n, a) => n + a.size, 0);

  const add = async (files: FileList | null) => {
    if (!files) return;
    const next = [...value];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) break;
      next.push({
        id: crypto.randomUUID(),
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        contentBase64: await readAsBase64(file),
      });
    }
    onChange(next);
    if (inputRef.current) inputRef.current.value = ""; // allow picking the same file again
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium">Attachments</span>
        <span className="text-xs text-muted tabular">
          {formatBytes(used)} / {formatBytes(MAX_ATTACHMENT_BYTES)} · {value.length}/{MAX_ATTACHMENTS}
        </span>
      </div>
      {value.length > 0 && (
        <ul className="mb-2 grid gap-1.5">
          {value.map((a, i) => (
            <li key={a.id} className="flex items-center justify-between rounded-lg border border-line bg-subtle px-3 py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Paperclip className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="truncate">{a.filename}</span>
                <span className="shrink-0 text-xs text-muted">{formatBytes(a.size)}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="rounded p-1 text-muted hover:text-bad"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        aria-label="Choose files to attach"
        className="sr-only"
        id="attach-input"
        onChange={(e) => void add(e.target.files)}
      />
      <Button
        variant="secondary"
        size="sm"
        icon={<Paperclip className="size-4" />}
        onClick={() => inputRef.current?.click()}
        disabled={value.length >= MAX_ATTACHMENTS}
      >
        Add files
      </Button>
      {error && (
        <p role="alert" className="mt-1.5 text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
