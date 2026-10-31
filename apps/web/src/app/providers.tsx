"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => {
    // Primes the CSRF cookie so the first mutating request (e.g. logout) has a
    // token to double-submit. Signup/login are exempt server-side since no
    // session exists yet at that point.
    apiFetch("/auth/csrf").catch(() => undefined);
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
