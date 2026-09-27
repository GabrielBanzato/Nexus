import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMe } from './api.js';

const AuthContext = createContext(null);

/** Carrega o utilizador autenticado (/api/auth/me) e expõe permissões derivadas do papel. */
export function AuthProvider({ onLogout, children }) {
  const { data: user, isLoading } = useQuery({ queryKey: ['me'], queryFn: getMe, staleTime: 5 * 60_000 });

  const value = useMemo(
    () => ({
      user,
      isLoading,
      logout: onLogout,
      isAdmin: user?.role === 'admin',
      // admin e partner gerem clientes, chamados, quadro e veem a equipe.
      isManager: user?.role === 'admin' || user?.role === 'partner',
    }),
    [user, isLoading, onLogout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth deve ser usado dentro de <AuthProvider>.');
  return context;
}
