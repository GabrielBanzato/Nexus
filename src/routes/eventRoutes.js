import { subscribe } from '../lib/events.js';

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/events: stream Server-Sent Events com avisos de mudança por tópico.
 * O cliente usa fetch com o header Authorization (EventSource não envia headers),
 * por isso a rota fica atrás do mesmo hook de autenticação das outras.
 */
export default async function eventRoutes(app) {
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx: não fazer buffer do stream
    });
    // 2 KB de comentário no início: alguns proxies/antivírus só libertam o buffer quando enche.
    res.write(`:${' '.repeat(2048)}\nretry: 5000\n\n`);

    const unsubscribe = subscribe((event) => res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`));
    // Comentário periódico: mantém a ligação viva através de proxies e deteta clientes mortos.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
