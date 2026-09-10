import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, AUTH_REQUIRED_EVENT } from '@/lib/api';
import { AuthContext } from '@/hooks/useAuth';
import type { AuthStatus } from '@shared/types';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.authStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Failed to load auth status');
    } finally {
      setLoading(false);
    }
  }, []);

  const retry = useCallback(async () => {
    setLoading(true);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    api.authStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load auth status');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const expireSession = () => {
      setStatus((current) => current ? { ...current, authenticated: false, username: null } : current);
      setError('Your session has expired. Please sign in again.');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, expireSession);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, expireSession);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      await api.login(username, password);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log in');
      throw err;
    }
  }, [refresh]);

  const setup = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      await api.setup(username, password);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create admin account');
      throw err;
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    setError(null);
    try {
      await api.logout();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log out');
      throw err;
    }
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ status, loading, error, refresh: retry, login, setup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
