import { Sparkles } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../app/services";
import { ApiError } from "../../shared/api/http";
import { useMeta } from "../../shared/api/queries";
import { Button } from "../../shared/ui/button";
import { useToast } from "../../shared/ui/toast";
import { useAuth } from "../auth/auth-context";

const randomId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

/**
 * Visible only when the server runs in demo mode. One click creates a throwaway account that already has an SMTP
 * account pointing at the bundled fake SMTP server, so a visitor lands on a working product instead of an empty form.
 */
export function DemoButton() {
  const meta = useMeta();
  const api = useApi();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  if (!meta.data?.demo) return null;
  const demoSmtp = meta.data.demoSmtp;

  const start = async () => {
    setBusy(true);
    try {
      await auth.register({ email: `demo-${randomId()}@courier-demo.test`, password: `${randomId()}${randomId()}` });
      if (demoSmtp) {
        await api.smtp.create({
          name: "Demo SMTP (local sink)",
          host: demoSmtp.host,
          port: demoSmtp.port,
          secure: false,
          username: "demo",
          password: "demo",
          fromEmail: "hello@courier-demo.test",
          fromName: "Courier Demo",
          limits: { perSecond: 200 },
          maxConnections: 10,
        });
      }
      navigate("/", { replace: true });
    } catch (e) {
      toast.error("Could not start the demo", e instanceof ApiError ? e.message : "Unexpected error");
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <Button variant="secondary" onClick={start} loading={busy} icon={<Sparkles className="size-4 text-accent" />} className="w-full">
        Explore with a demo account
      </Button>
    </>
  );
}
