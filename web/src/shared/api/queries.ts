import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../app/services";

/** Query keys in one place: invalidating "emails" after a send is a one-liner and typo-proof. */
export const keys = {
  meta: ["meta"] as const,
  dashboard: ["dashboard"] as const,
  smtp: ["smtp"] as const,
  emails: ["emails"] as const,
  suppressions: ["suppressions"] as const,
};

export function useMeta() {
  const api = useApi();
  return useQuery({ queryKey: keys.meta, queryFn: () => api.meta(), staleTime: Infinity, retry: 1 });
}

export function useSmtpAccounts() {
  const api = useApi();
  return useQuery({ queryKey: keys.smtp, queryFn: async () => (await api.smtp.list()).items });
}
