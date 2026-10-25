import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/services";
import type { Credentials } from "../../shared/api/endpoints";
import type { User } from "../../shared/api/schemas";
import { useToast } from "../../shared/ui/toast";

export type AuthState = { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; user: User };

interface AuthApi {
  state: AuthState;
  login(c: Credentials): Promise<void>;
  register(c: Credentials): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

/**
 * Session lifecycle. The refresh token lives in an HttpOnly cookie the browser manages; the access token lives in
 * memory. On a page load we ask the server "do I still have a session?" (one refresh call) instead of reading any
 * stored credential, so there is nothing for an injected script to steal.
 */
export function AuthProvider({ children, initialState }: { children: ReactNode; initialState?: AuthState }) {
  const { api, http, tokens, sessionHandlers } = useServices();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<AuthState>(initialState ?? { status: "loading" });
  const stateRef = useRef(state);
  stateRef.current = state;

  // The HTTP client reports an unrecoverable 401 here: drop to the login screen and forget cached data.
  useEffect(() => {
    sessionHandlers.onLost = () => {
      if (stateRef.current.status === "authenticated") toast.info("Session expired", "Please sign in again.");
      queryClient.clear();
      setState({ status: "anonymous" });
    };
    return () => {
      sessionHandlers.onLost = () => {};
    };
  }, [sessionHandlers, queryClient, toast]);

  // Restore an existing session on first load (skipped when the caller already knows the state, e.g. tests).
  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    (async () => {
      if (await http.refresh()) {
        try {
          const me = await api.auth.me();
          if (!cancelled) setState({ status: "authenticated", user: { id: me.id, email: me.email } });
          return;
        } catch {
          /* fall through to anonymous */
        }
      }
      if (!cancelled) setState({ status: "anonymous" });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, http, initialState]);

  const establish = useCallback(
    async (result: { accessToken: string; user?: User }) => {
      tokens.set(result.accessToken);
      queryClient.clear(); // never show the previous account's cached data to the next one
      const user = result.user ?? (await api.auth.me());
      setState({ status: "authenticated", user: { id: user.id, email: user.email } });
    },
    [api, tokens, queryClient],
  );

  const value = useMemo<AuthApi>(
    () => ({
      state,
      login: async (c) => establish(await api.auth.login(c)),
      register: async (c) => establish(await api.auth.register(c)),
      logout: async () => {
        try {
          await api.auth.logout();
        } finally {
          tokens.set(null);
          queryClient.clear();
          setState({ status: "anonymous" });
        }
      },
    }),
    [state, api, tokens, queryClient, establish],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== "authenticated") throw new Error("useUser requires an authenticated session");
  return state.user;
}
