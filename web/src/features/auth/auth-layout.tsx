import { Activity, Gauge, ShieldCheck, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "../../app/brand";

const POINTS = [
  {
    icon: Gauge,
    title: "Rate-aware",
    text: "Declare your SMTP limit once. An adaptive controller finds the real ceiling and stays under it.",
  },
  {
    icon: ShieldCheck,
    title: "Never loses mail",
    text: "Durable outbox, atomic claims, self-healing queue. Survives crashed workers and a wiped Redis.",
  },
  {
    icon: Zap,
    title: "Built to scale",
    text: "Thousands of emails per second per machine, paced per account so one tenant never starves another.",
  },
  { icon: Activity, title: "Observable", text: "Live throughput, per-account rate state, bounces and complaints, all in one place." },
];

/** Two-column auth shell: product pitch on the left (hidden on small screens), the form on the right. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#0f1330] p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -left-24 -top-24 size-96 rounded-full bg-indigo-500/30 blur-3xl" aria-hidden="true" />
        <div
          className="pointer-events-none absolute -bottom-32 right-0 size-[28rem] rounded-full bg-violet-500/20 blur-3xl"
          aria-hidden="true"
        />
        <Brand className="relative text-white" />
        <div className="relative max-w-lg">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">Email delivery that respects the rate limit.</h2>
          <p className="mt-4 text-lg text-indigo-100/80">
            Bring your own SMTP. Send at scale. Know exactly what happened to every message.
          </p>
          <ul className="mt-10 grid gap-5">
            {POINTS.map(({ icon: Icon, title: t, text }) => (
              <li key={t} className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10" aria-hidden="true">
                  <Icon className="size-5 text-indigo-200" />
                </span>
                <span>
                  <span className="block font-medium">{t}</span>
                  <span className="text-sm text-indigo-100/70">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-indigo-100/75">Bun · Hono · MongoDB · Redis · BullMQ · React</p>
      </aside>

      <main className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">
          <Brand className="mb-8 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
