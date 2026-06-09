/**
 * AccessDeniedContext — a minimal React context used to pass an "access
 * denied" notice from RoleGuard (which triggers the redirect) to the
 * Dashboard (which renders the banner).
 *
 * Intentionally uses React state — never localStorage/sessionStorage.
 * The message clears on the next navigation or explicit dismiss.
 */
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface AccessDeniedContextValue {
  message: string | null;
  setMessage: (msg: string | null) => void;
}

const AccessDeniedContext = createContext<AccessDeniedContextValue>({
  message: null,
  setMessage: () => undefined,
});

export function AccessDeniedProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <AccessDeniedContext.Provider value={{ message, setMessage }}>
      {children}
    </AccessDeniedContext.Provider>
  );
}

export function useAccessDenied(): AccessDeniedContextValue {
  return useContext(AccessDeniedContext);
}
