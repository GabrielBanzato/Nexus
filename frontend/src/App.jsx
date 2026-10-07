import { useCallback, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import AppShell from './components/AppShell.jsx';
import { ToastProvider } from './components/toast.jsx';
import Login from './Login.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { queryClient } from './lib/queryClient.js';
import { forgetPushOnThisDevice } from './lib/pwa.js';
import { closeSocket } from './lib/socket.js';
import {
  SESSION_EXPIRED_EVENT,
  TOKEN_STORAGE_KEY,
  clearToken,
  getToken,
  getTokenExpiry,
  notifySessionExpired,
  saveToken,
} from './lib/session.js';

const MAX_TIMEOUT_MS = 2_147_483_647; // limite do setTimeout (~24,8 dias)

/** Guard de rota: sem token válido, renderiza o fallback (tela de login). */
function ProtectedRoute({ token, fallback, children }) {
  return token ? children : fallback;
}

export default function App() {
  const [token, setToken] = useState(() => getToken());
  const [notice, setNotice] = useState(null);

  // Qualquer 401 da API (token expirado/revogado, conta desativada) derruba a sessão.
  useEffect(() => {
    const handleExpired = () => {
      closeSocket();
      queryClient.clear();
      setToken(null);
      setNotice('Sua sessão expirou. Entre novamente para continuar.');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
  }, []);

  // Login/logout noutra aba: o localStorage é partilhado, então esta aba adota a nova sessão
  // (sem isto ficaria com a interface de um utilizador e os dados de outro).
  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key !== TOKEN_STORAGE_KEY && event.key !== null) return;
      const next = getToken();
      closeSocket(); // a ligação era do utilizador anterior
      queryClient.clear();
      setToken(next);
      setNotice(next ? null : 'A sessão foi terminada noutra aba.');
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Encerra a sessão no momento exato em que o token expira, mesmo sem requisições.
  useEffect(() => {
    if (!token) return undefined;
    const msUntilExpiry = getTokenExpiry(token) - Date.now();
    if (msUntilExpiry > MAX_TIMEOUT_MS) return undefined;
    const timer = setTimeout(notifySessionExpired, Math.max(0, msUntilExpiry));
    return () => clearTimeout(timer);
  }, [token]);

  const handleLogin = useCallback((newToken) => {
    queryClient.clear(); // nunca reaproveitar cache de outra sessão
    saveToken(newToken);
    setNotice(null);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    forgetPushOnThisDevice(); // as notificações desta conta não continuam a chegar a este aparelho
    clearToken();
    closeSocket();
    queryClient.clear();
    setNotice(null);
    setToken(null);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProtectedRoute token={token} fallback={<Login onSuccess={handleLogin} notice={notice} />}>
          <AuthProvider onLogout={handleLogout}>
            <AppShell />
          </AuthProvider>
        </ProtectedRoute>
      </ToastProvider>
    </QueryClientProvider>
  );
}
