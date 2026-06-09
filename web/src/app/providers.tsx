/**
 * Providers — wraps the application with global context providers.
 *
 * Currently:
 * - QueryClientProvider (TanStack React Query v5)
 *   staleTime: 5 min for public queries (CMS, blog, events change rarely)
 *   retry: 1 (one automatic retry on transient network errors)
 *
 * Auth provider intentionally absent at this stage — added in Phase 7
 * once the session/identity plumbing (useCurrentUser / GET /me) lands.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes — public content changes rarely
      retry: 1,
    },
  },
});

export interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
