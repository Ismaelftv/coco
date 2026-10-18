import { useCallback, useEffect, useState } from 'react';
import type { User } from '../../../../../shared/contract.ts';
import { api, HttpError, onUnauthorized } from '../../lib/api.ts';

export type AuthState =
  | { status: 'checking' }
  | { status: 'offline'; message: string }
  | { status: 'signed-out'; signupEnabled: boolean; expired: boolean }
  | { status: 'signed-in'; user: User };

export function useAuth() {
  const [state, setState] = useState<AuthState>({ status: 'checking' });

  const check = useCallback(async () => {
    setState({ status: 'checking' });
    try {
      const { user } = await api.me();
      setState({ status: 'signed-in', user });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        const cfg = await api.authConfig().catch(() => ({ signupEnabled: true }));
        setState({ status: 'signed-out', signupEnabled: cfg.signupEnabled, expired: false });
      } else {
        setState({ status: 'offline', message: (err as Error).message });
      }
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Uma sessão que expira a meio do uso devolve o utilizador ao ecrã de entrada.
  useEffect(
    () =>
      onUnauthorized(() =>
        setState((s) => (s.status === 'signed-in' ? { status: 'signed-out', signupEnabled: true, expired: true } : s)),
      ),
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.login(email, password);
    setState({ status: 'signed-in', user });
  }, []);

  const signup = useCallback(async (email: string, password: string, displayName?: string) => {
    const { user } = await api.signup(email, password, displayName);
    setState({ status: 'signed-in', user });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState({ status: 'signed-out', signupEnabled: true, expired: false });
  }, []);

  return { state, check, login, signup, logout };
}
