import { useMeta } from "../shared/api/queries";
import { useAuth } from "../features/auth/auth-context";
import { AUTHOR, DEMO_EMAIL_DOMAIN } from "./credits";

/** Slim strip above every screen: who wrote this, and where to find them and the code. */
export function CreditsBar() {
  const links = AUTHOR.links.filter((l) => l.href);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-subtle px-4 py-1.5 text-xs text-muted">
      <p>
        Designed and built by <span className="font-medium text-fg">{AUTHOR.name}</span>
      </p>
      <nav aria-label="Author" className="flex flex-wrap gap-x-4 gap-y-1">
        {links.map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
            {l.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

const DEMO_NOTICE =
  "This is just a demo: the backend only mimics an SMTP host, so no emails are actually sent. To see the real thing, create an account and set up your own SMTP account.";

/** Only for demo accounts (signed in, demo mode on): a scrolling notice, static and wrapped under reduced motion. */
export function DemoBanner() {
  const meta = useMeta();
  const { state } = useAuth();
  const isDemoAccount = state.status === "authenticated" && state.user.email.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
  if (!meta.data?.demo || !isDemoAccount) return null;
  return (
    <div role="status" className="group overflow-hidden border-b border-amber-500/40 bg-amber-500/15 py-2 text-sm text-fg">
      <span className="sr-only">{DEMO_NOTICE}</span>
      <div
        aria-hidden="true"
        className="flex w-max animate-[marquee_45s_linear_infinite] whitespace-nowrap group-hover:[animation-play-state:paused] motion-reduce:w-auto motion-reduce:animate-none motion-reduce:whitespace-normal motion-reduce:px-4"
      >
        <span className="px-8 font-medium">⚠ DEMO · {DEMO_NOTICE}</span>
        <span className="px-8 font-medium motion-reduce:hidden">⚠ DEMO · {DEMO_NOTICE}</span>
      </div>
    </div>
  );
}
