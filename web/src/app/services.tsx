import { createContext, type ReactNode, useContext } from "react";
import { type Api, createApi } from "../shared/api/endpoints";
import { type FetchFn, HttpClient, MemoryTokenStore, type TokenStore } from "../shared/api/http";

/** Everything the UI needs from the outside world, built once at startup and injected through context. */
export interface Services {
  api: Api;
  http: HttpClient;
  tokens: TokenStore;
  /** the auth provider plugs its "session lost" reaction in here (avoids a circular dependency with the client) */
  sessionHandlers: { onLost: () => void };
}

export function createServices(fetchImpl: FetchFn = (input, init) => fetch(input, init)): Services {
  const tokens = new MemoryTokenStore();
  const sessionHandlers = { onLost: () => {} };
  const http = new HttpClient({ fetch: fetchImpl, tokens, onSessionLost: () => sessionHandlers.onLost() });
  return { api: createApi(http), http, tokens, sessionHandlers };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error("useServices must be used inside <ServicesProvider>");
  return ctx;
}

export const useApi = (): Api => useServices().api;
