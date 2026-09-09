import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import type { AuthStatus } from '@shared/types';

interface AuthContextValue {
  status: AuthStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.authStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load auth status');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      setError(null);
      try {
        await api.login(username, password);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to log in';
        setError(message);
        throw err;
      }
    },
    [refresh],
  );

  const setup = useCallback(
    async (username: string, password: string) => {
      setError(null);
      try {
        await api.setup(username, password);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create admin account';
        setError(message);
        throw err;
      }
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    setError(null);
    try {
      await api.logout();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to log out';
      setError(message);
      throw err;
    }
  }, [refresh]);

  return createElement(
    AuthContext.Provider,
    { value: { status, loading, error, refresh, login, setup, logout } },
    children,
  );
}

function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export { AuthProvider, useAuth };
