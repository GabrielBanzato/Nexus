import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getUserDirectory, listClients } from './api.js';

export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Utilizadores ativos (id, name, role) para selects de responsável/atribuição. */
export function useUserDirectory() {
  return useQuery({ queryKey: ['users', 'directory'], queryFn: getUserDirectory, staleTime: 5 * 60_000 });
}

/** Clientes para o select de chamados (até 200, ordenados por atualização). */
export function useClientOptions() {
  return useQuery({
    queryKey: ['clients', 'options'],
    queryFn: () => listClients({ limit: 200 }).then((res) => res.data),
    staleTime: 60_000,
  });
}
