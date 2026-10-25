import { LayoutDashboard, LogOut, Mail, Menu, Monitor, Moon, Send, Server, Settings, ShieldOff, Sun } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth, useUser } from "../features/auth/auth-context";
import { cn } from "../shared/lib/cn";
import { useTheme } from "../shared/theme/theme";
import { Button } from "../shared/ui/button";
import { Dialog } from "../shared/ui/dialog";
import { Brand } from "./brand";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/send", label: "Send", icon: Send },
  { to: "/emails", label: "Emails", icon: Mail },
  { to: "/smtp", label: "SMTP accounts", icon: Server },
  { to: "/suppressions", label: "Suppressions", icon: ShieldOff },
  { to: "/settings", label: "Settings", icon: Settings },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-subtle hover:text-fg",
            )
          }
        >
          <Icon className="size-4.5" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const order = ["system", "light", "dark"] as const;
  const next = order[(order.indexOf(choice) + 1) % order.length]!;
  const Icon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setChoice(next)}
      aria-label={`Theme: ${choice}. Switch to ${next}`}
      icon={<Icon className="size-4" />}
    >
      <span className="capitalize">{choice}</span>
    </Button>
  );
}

function AccountFooter() {
  const user = useUser();
  const { logout } = useAuth();
  return (
    <div className="mt-auto border-t border-line pt-4">
      <p className="truncate px-3 text-xs text-muted" title={user.email}>
        {user.email}
      </p>
      <div className="mt-2 flex items-center justify-between">
        <ThemeToggle />
        <Button variant="ghost" size="sm" onClick={() => void logout()} icon={<LogOut className="size-4" />}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-on-accent"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface p-4 lg:flex">
        <Brand className="px-2 pt-1" />
        <NavList />
        <AccountFooter />
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <Button variant="ghost" size="sm" onClick={() => setMenuOpen(true)} aria-label="Open menu" icon={<Menu className="size-5" />} />
      </header>
      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" variant="drawer" className="w-[min(100vw,18rem)]">
        <div className="flex h-full flex-col gap-6">
          <NavList onNavigate={() => setMenuOpen(false)} />
          <AccountFooter />
        </div>
      </Dialog>

      {/* key on pathname restarts the entrance animation per page, and moves focus target semantics to <main> */}
      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 outline-none sm:px-8 sm:py-8">
        <div key={location.pathname} className="mx-auto max-w-6xl animate-[fade-in_.25s_ease-out]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
