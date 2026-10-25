import { Navigate, Outlet } from "react-router";
import { Spinner } from "../../shared/ui/spinner";
import { AuthLayout } from "./auth-layout";
import { useAuth } from "./auth-context";
import { CredentialsForm } from "./credentials-form";

export function LoginPage() {
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to see your deliveries.">
      <CredentialsForm mode="login" />
    </AuthLayout>
  );
}

export function RegisterPage() {
  return (
    <AuthLayout title="Create your account" subtitle="Add your SMTP account and send your first email in two minutes.">
      <CredentialsForm mode="register" />
    </AuthLayout>
  );
}

export function FullScreenSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-accent">
      <Spinner className="size-8" label="Loading" />
    </div>
  );
}

/** Gate for the app: waits for session restore, sends anonymous visitors to /login. */
export function RequireAuth() {
  const { state } = useAuth();
  if (state.status === "loading") return <FullScreenSpinner />;
  if (state.status === "anonymous") return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Gate for /login and /register: signed-in users go straight to the dashboard. */
export function RedirectIfAuthed() {
  const { state } = useAuth();
  if (state.status === "loading") return <FullScreenSpinner />;
  if (state.status === "authenticated") return <Navigate to="/" replace />;
  return <Outlet />;
}
