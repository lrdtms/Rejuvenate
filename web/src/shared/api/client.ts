/**
 * apiFetch — typed fetch wrapper.
 *
 * Contract:
 * - Base URL from VITE_API_BASE_URL env var; defaults to '' (same-origin) when
 *   the variable is not set, so relative paths work transparently.
 * - Always sends credentials: 'include' (HttpOnly session cookies — never
 *   read/store auth tokens in localStorage/sessionStorage).
 * - On non-2xx: parses { error: { code, message, fields? } } body and throws
 *   ApiError with status + structured body.
 * - 401 is thrown as a normal ApiError (code will be e.g. 'UNAUTHORIZED');
 *   callers (RequireAuth, React Query error handlers) detect it via
 *   isApiError(e) && e.status === 401 and redirect to /admin/login.
 * - Exports isApiError type guard for narrowing in catch blocks.
 */
import { ApiError, isApiError } from './errors';
import type { ApiErrorBody } from './errors';

export { isApiError };

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });

  if (response.ok) {
    // 204 No Content — return null cast to T
    if (response.status === 204) {
      return null as unknown as T;
    }
    return response.json() as Promise<T>;
  }

  // Non-2xx — attempt to parse the standard error envelope
  let body: ApiErrorBody;
  try {
    const envelope = (await response.json()) as { error?: ApiErrorBody };
    if (envelope.error && typeof envelope.error === 'object') {
      body = envelope.error;
    } else {
      // Unexpected shape — synthesize a generic error body
      body = {
        code: 'UNKNOWN_ERROR',
        message: `HTTP ${response.status}`,
      };
    }
  } catch {
    body = {
      code: 'UNKNOWN_ERROR',
      message: `HTTP ${response.status}`,
    };
  }

  throw new ApiError(response.status, body);
}
