import { QueryClient } from '@tanstack/react-query';

/**
 * Cache de estado do servidor (TanStack Query).
 * - Erros 4xx não são repetidos (sem sentido repetir 403/404/validação).
 * - Refetch ao voltar à aba mantém a equipa sincronizada sem polling.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => (error?.status >= 400 && error?.status < 500 ? false : failureCount < 2),
    },
    mutations: { retry: false },
  },
});
