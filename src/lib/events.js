import { EventEmitter } from 'node:events';

/**
 * Barramento de eventos em memória para atualizações em tempo real (SSE).
 * Transporta apenas "o quê mudou" (tópico), nunca dados: cada cliente volta a pedir
 * o que precisa pelas rotas normais, com as suas próprias permissões.
 *
 * Com várias instâncias do backend seria preciso um broker (ex.: Redis pub/sub).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const TOPICS = ['deals', 'triage', 'kanban', 'tickets', 'clients', 'users'];

/** Publica que o `topic` mudou; `by` permite ao cliente ignorar os próprios eventos. */
export function publish(topic, request) {
  bus.emit('change', { topic, by: request?.currentUser?.id ?? null, at: Date.now() });
}

export function subscribe(listener) {
  bus.on('change', listener);
  return () => bus.off('change', listener);
}
