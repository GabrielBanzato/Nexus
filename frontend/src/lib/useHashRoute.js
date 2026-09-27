import { useCallback, useEffect, useState } from 'react';

/**
 * Roteamento mínimo por hash (#/kanban). Sem dependências e compatível com qualquer
 * servidor estático (o Nginx não precisa de regras extras); F5 mantém a página.
 */
function readRoute(fallback) {
  const path = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return path || fallback;
}

export function useHashRoute(fallback) {
  const [route, setRoute] = useState(() => readRoute(fallback));

  useEffect(() => {
    const onChange = () => setRoute(readRoute(fallback));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [fallback]);

  const navigate = useCallback((to) => {
    window.location.hash = `/${to}`;
  }, []);

  return [route, navigate];
}
