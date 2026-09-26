import { useCallback, useEffect, useState } from 'react';
import Dashboard from './Dashboard.jsx';
import Login from './Login.jsx';
import {
  SESSION_EXPIRED_EVENT,
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

  // Qualquer 401 da API (token expirado/revogado) derruba a sessão.
  useEffect(() => {
    const handleExpired = () => {
      setToken(null);
      setNotice('Sua sessão expirou. Entre novamente para continuar.');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
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
    saveToken(newToken);
    setNotice(null);
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setNotice(null);
    setToken(null);
  }, []);

  return (
    <ProtectedRoute token={token} fallback={<Login onSuccess={handleLogin} notice={notice} />}>
      <Dashboard onLogout={handleLogout} />
    </ProtectedRoute>
  );
}
