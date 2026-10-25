import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, useState } from "react";
import { RouterProvider, createBrowserRouter, useRouteError } from "react-router";
import { FullScreenSpinner, LoginPage, RedirectIfAuthed, RegisterPage, RequireAuth } from "../features/auth/auth-pages";
import { AuthProvider } from "../features/auth/auth-context";
import { ApiError } from "../shared/api/http";
import { isChunkLoadError } from "../shared/lib/reload";
import { ThemeProvider } from "../shared/theme/theme";
import { Button } from "../shared/ui/button";
import { ToastProvider } from "../shared/ui/toast";
import { AppLayout } from "./layout";
import { lazyPage } from "./lazy-page";
import { type Services, ServicesProvider } from "./services";

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-5xl font-semibold text-accent">404</p>
      <p className="text-muted">That page does not exist.</p>
      <a href="/" className="font-medium text-accent hover:underline">
        Back to the dashboard
      </a>
    </div>
  );
}

/** Shown for any error thrown while a route loads or renders (instead of the library's raw developer error page). */
export function RouteError() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  return (
    <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">{stale ? "A new version is available" : "Something went wrong"}</h1>
      <p className="max-w-md text-sm text-muted">
        {stale
          ? "This page was opened before an update. Reload to continue."
          : error instanceof Error
            ? error.message
            : "Unexpected error."}
      </p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}

/** Last line of defence: a render bug shows a recoverable screen instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crashed", error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted">{this.state.error.message}</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

const router = createBrowserRouter([
  // one errorElement at the top covers every route below it
  {
    errorElement: <RouteError />,
    children: [
      {
        element: <RedirectIfAuthed />,
        children: [
          { path: "/login", element: <LoginPage /> },
          { path: "/register", element: <RegisterPage /> },
        ],
      },
      {
        element: <RequireAuth />,
        hydrateFallbackElement: <FullScreenSpinner />,
        children: [
          {
            element: <AppLayout />,
            children: [
              // each screen is its own chunk: the first paint only downloads what the first screen needs
              { index: true, lazy: lazyPage("/", () => import("../features/dashboard/dashboard-page"), "DashboardPage") },
              { path: "send", lazy: lazyPage("/send", () => import("../features/compose/compose-page"), "ComposePage") },
              { path: "emails", lazy: lazyPage("/emails", () => import("../features/emails/emails-page"), "EmailsPage") },
              { path: "smtp", lazy: lazyPage("/smtp", () => import("../features/smtp/smtp-page"), "SmtpPage") },
              {
                path: "suppressions",
                lazy: lazyPage("/suppressions", () => import("../features/suppressions/suppressions-page"), "SuppressionsPage"),
              },
              { path: "settings", lazy: lazyPage("/settings", () => import("../features/settings/settings-page"), "SettingsPage") },
            ],
          },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000,
        refetchOnWindowFocus: true,
        // auth/validation errors will not fix themselves: do not hammer the API retrying them
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

export function App({ services }: { services: Services }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ServicesProvider services={services}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <AuthProvider>
                <RouterProvider router={router} />
              </AuthProvider>
            </ToastProvider>
          </QueryClientProvider>
        </ServicesProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
