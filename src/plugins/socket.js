import { Server } from 'socket.io';
import { findUserById } from '../repositories/userRepository.js';

/**
 * Socket.io (tempo real com dados: conversas do WhatsApp, estado da sessão).
 *
 * Fica em /api/socket.io para passar pelos mesmos proxies de /api (Nginx em produção, Vite em
 * dev) sem regras de CORS. O SSE de /api/events continua a servir os avisos "tópico X mudou";
 * aqui vão eventos que carregam dados, por isso cada socket só entra nas salas que pode ver:
 *  - user:<id>   eventos dos clientes pelos quais esse utilizador é responsável;
 *  - role:admin  tudo (inclui QR Code e estado da sessão do WhatsApp).
 *
 * Com várias instâncias do backend seria preciso o adapter Redis do Socket.io.
 */

export const SOCKET_PATH = '/api/socket.io';

export const rooms = {
  admins: 'role:admin',
  user: (id) => `user:${id}`,
};

/** Salas que podem ver os eventos de um cliente: admins + o responsável (se houver). */
export function clientAudience(client) {
  return client.responsible_id ? [rooms.admins, rooms.user(client.responsible_id)] : [rooms.admins];
}

/**
 * Derruba as ligações de um utilizador (ex.: desativado ou mudou de papel). O cliente
 * reconecta e passa de novo pela autenticação, com as salas certas — ou é recusado.
 */
export function disconnectUser(io, userId) {
  io?.in(rooms.user(userId)).disconnectSockets(true);
}

/** Cria o servidor Socket.io no mesmo HTTP server do Fastify. Requer registerAuth antes (app.jwt). */
export function registerSocket(app) {
  const io = new Server(app.server, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: { origin: false }, // só mesma origem (via proxy)
    // Áudio do Nex nas reuniões (nex:audio) chega por aqui: até 2 MB por pedaço (meetingNex.js).
    // O padrão (1 MB) derrubava a mensagem sem aviso.
    maxHttpBufferSize: 3e6,
  });

  // Autenticação no handshake: o frontend envia o mesmo JWT da API em `auth.token`.
  // Tal como no HTTP, o utilizador é relido do banco (conta desativada = recusada).
  io.use(async (socket, next) => {
    try {
      const payload = app.jwt.verify(socket.handshake.auth?.token ?? '');
      const user = Number.isInteger(payload.sub) ? await findUserById(payload.sub) : null;
      if (!user?.is_active) throw new Error('inactive');
      socket.data.user = user;
      socket.data.tokenExp = payload.exp;
      next();
    } catch {
      next(new Error('UNAUTHORIZED')); // o cliente recebe connect_error com esta mensagem
    }
  });

  io.on('connection', (socket) => {
    const { user, tokenExp } = socket.data;
    socket.join(rooms.user(user.id));
    if (user.role === 'admin') socket.join(rooms.admins);

    // O token expira com a ligação aberta: desliga no momento da expiração.
    if (tokenExp) {
      const timer = setTimeout(() => socket.disconnect(true), Math.max(0, tokenExp * 1000 - Date.now()));
      socket.on('disconnect', () => clearTimeout(timer));
    }
  });

  app.decorate('io', io);

  // Não usar io.close(): fecharia o HTTP server que é do Fastify.
  app.addHook('preClose', async () => {
    io.local.disconnectSockets(true);
  });
  app.addHook('onClose', async () => {
    io.engine.close();
  });

  return io;
}
