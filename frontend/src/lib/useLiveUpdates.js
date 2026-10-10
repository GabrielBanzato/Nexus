import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken } from './session.js';

const API_URL = import.meta.env.VITE_API_URL ?? '';

const FIRST_BYTE_TIMEOUT_MS = 8_000; // sem dados neste tempo = stream retido no caminho
const POLL_INTERVAL_MS = 15_000;
const RETRY_STREAM_MS = 60_000; // em modo periódico, volta a tentar o tempo real

// Tópico do servidor → caches do TanStack Query a revalidar.
const INVALIDATES = {
  deals: [['deals'], ['metrics'], ['activity']],
  triage: [['triage'], ['metrics']],
  kanban: [['kanban']],
  tickets: [['tickets'], ['activity']],
  clients: [['clients'], ['activity'], ['conversations']],
  users: [['users']],
};
const ALL_KEYS = [...new Map(Object.values(INVALIDATES).flat().map((key) => [key[0], key])).values()];

/**
 * Atualizações da equipe em tempo real.
 *
 * 1. Server-Sent Events via fetch (para enviar o token no header). Ao receber "X mudou",
 *    invalida as queries afetadas; o TanStack Query só refaz as que estão no ecrã.
 *    Eventos do próprio utilizador são ignorados (as mutações locais já atualizam o cache).
 * 2. Fallback: antivírus (ex.: web anti-virus que inspeciona tráfego), proxies corporativos e
 *    algumas redes retêm respostas em streaming. Se o primeiro byte não chegar em 8s, passa a
 *    sincronizar a cada 15s e volta a tentar o stream a cada minuto.
 *
 * @returns {'connecting' | 'live' | 'polling' | 'offline'}
 */
export function useLiveUpdates(userId) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('connecting');
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    let stopped = false;
    let controller;
    let retryTimer;
    let pollTimer;
    let attempt = 0;

    const invalidate = (keys) => keys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));

    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => invalidate(ALL_KEYS), POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const handle = (raw) => {
      const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) return;
      try {
        const event = JSON.parse(dataLine.slice(5));
        if (event.by && event.by === userIdRef.current) return;
        invalidate(INVALIDATES[event.topic] ?? []);
      } catch {
        // evento malformado: ignora
      }
    };

    const connect = async () => {
      const token = getToken();
      if (!token || stopped) return;
      controller = new AbortController();
      let timedOut = false;
      let receiving = false;
      const firstByteTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FIRST_BYTE_TIMEOUT_MS);

      try {
        const res = await fetch(`${API_URL}/api/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
          // Sem isto o Chrome aplica o "cache lock": um 2º GET para a mesma URL espera o 1º
          // terminar, e um stream SSE nunca termina (ex.: reconexão, StrictMode, 2 abas).
          cache: 'no-store',
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!receiving) {
            receiving = true;
            // Só é "ao vivo" quando os dados chegam de facto (não basta chegarem os headers).
            clearTimeout(firstByteTimer);
            stopPolling();
            setStatus('live');
            attempt = 0;
          }
          buffer += value;
          const parts = buffer.split('\n\n');
          buffer = parts.pop();
          parts.forEach(handle);
        }
      } catch (err) {
        clearTimeout(firstByteTimer);
        if (err.name === 'AbortError' && !timedOut) return; // desmontado / logout
      }
      if (stopped) return;

      if (timedOut) {
        // Stream retido no caminho: sincronização periódica + nova tentativa daqui a 1 min.
        setStatus('polling');
        invalidate(ALL_KEYS);
        startPolling();
        retryTimer = setTimeout(connect, RETRY_STREAM_MS);
        return;
      }
      setStatus(pollTimer ? 'polling' : 'offline');
      retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      stopPolling();
      controller?.abort();
    };
  }, [queryClient]);

  return status;
}
