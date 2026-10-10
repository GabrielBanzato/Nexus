import { config } from '../config/env.js';
import { findMeetingByCode, updateMeeting } from '../repositories/meetingRepository.js';
import { findUserById } from '../repositories/userRepository.js';
import { iceServers } from '../services/turn.js';

/**
 * Sinalização das videochamadas (WebRTC P2P) no namespace Socket.io "/meet".
 *
 * O servidor só apresenta os navegadores uns aos outros (oferta/resposta SDP e candidatos ICE);
 * o áudio/vídeo flui DIRETO entre eles (ou pelo TURN quando a rede bloqueia). Nada de mídia
 * passa por aqui: na KVM 2 isto é praticamente custo zero.
 *
 * Namespace separado do principal ("/"): o cliente entra SEM conta (só com o link) e nunca
 * pode alcançar os eventos do CRM (mensagens, clientes...). Aqui cada socket só fala com quem
 * está na mesma sala.
 *
 * Regras:
 *  - Equipe (token JWT válido) entra direto. Convidados esperam na "sala de espera" até alguém
 *    da equipe estar presente (um link reencaminhado não junta desconhecidos sozinhos).
 *  - Máximo de MEET_MAX_PARTICIPANTS (P2P em malha: acima de 3 cada um enviaria vídeo demais).
 *  - Gravação: só a equipe liga, e TODOS veem o aviso (LGPD: quem é gravado tem de saber).
 *  - "Encerrar para todos": só a equipe; a sala fica fechada (o link deixa de funcionar).
 *  - Nex (services/meetingNex.js): a equipe entra também na sala "meet-staff:<id>", onde chegam
 *    a transcrição e os pontos da reunião; o áudio vem do navegador de quem conduz (nex:audio).
 *    Os convidados só recebem o aviso de que a conversa está a ser transcrita (meet:nex).
 */

const MAX_NAME = 60;
const cleanName = (value) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NAME);

export function registerMeetSignaling(app, io, { nex = null } = {}) {
  const nsp = io.of('/meet');
  const recording = new Map(); // meetingId → { by } enquanto alguém grava

  const roomOf = (meetingId) => `meet:${meetingId}`;
  const lobbyOf = (meetingId) => `meet-lobby:${meetingId}`;
  const peerInfo = (s) => ({ id: s.id, name: s.data.name, staff: s.data.staff, media: s.data.media });

  nsp.use(async (socket, next) => {
    try {
      const { code, name, token } = socket.handshake.auth ?? {};
      const meeting = await findMeetingByCode(String(code ?? '').slice(0, 32));
      if (!meeting) throw new Error('NOT_FOUND');
      if (meeting.status === 'ended') throw new Error('ENDED');

      let user = null;
      if (token) {
        try {
          const payload = app.jwt.verify(token);
          const found = Number.isInteger(payload.sub) ? await findUserById(payload.sub) : null;
          if (found?.is_active) user = found;
        } catch {
          // token expirado/inválido: entra como convidado (com o nome digitado)
        }
      }
      const displayName = user?.name ?? cleanName(name);
      if (!displayName) throw new Error('NAME_REQUIRED');

      socket.data = { meetingId: meeting.id, meeting, user, staff: Boolean(user), name: displayName, media: { mic: true, cam: true, screen: false } };
      next();
    } catch (err) {
      next(new Error(['NOT_FOUND', 'ENDED', 'NAME_REQUIRED'].includes(err.message) ? err.message : 'ERROR'));
    }
  });

  async function admit(socket) {
    const { meetingId } = socket.data;
    const room = roomOf(meetingId);
    const inRoom = await nsp.in(room).fetchSockets();
    if (inRoom.length >= config.meet.maxParticipants) {
      socket.emit('meet:full', { max: config.meet.maxParticipants });
      socket.disconnect(true);
      return;
    }
    socket.leave(lobbyOf(meetingId));
    socket.join(room);
    if (socket.data.staff) socket.join(`meet-staff:${meetingId}`);
    socket.data.admitted = true;
    socket.emit('meet:joined', {
      self: peerInfo(socket),
      peers: inRoom.map(peerInfo),
      iceServers: iceServers(socket.data.user?.id ?? `guest-${socket.id}`),
      recording: recording.get(meetingId) ?? null,
      // Há relé TURN? Sem ele, redes que bloqueiam a ligação direta (4G, Wi-Fi corporativo) ficam
      // eternamente "Conectando..." — o ecrã explica isso à equipe.
      relay: Boolean(config.meet.turnUrls.length && config.meet.turnSecret),
      nex: nex ? { available: nex.available, listening: nex.isListening(meetingId) } : { available: false, listening: false },
      meeting: { title: socket.data.meeting.title, host_name: socket.data.meeting.host_name },
    });
    socket.to(room).emit('meet:peer-joined', peerInfo(socket));

    if (inRoom.length === 0) await updateMeeting(meetingId, { status: 'live', started_at: socket.data.meeting.started_at ?? new Date() });
  }

  /** Alguém da equipe na sala: deixa entrar quem está à espera (até encher). */
  async function admitLobby(meetingId) {
    for (const waiting of await nsp.in(lobbyOf(meetingId)).fetchSockets()) {
      const socket = nsp.sockets.get(waiting.id);
      if (socket) await admit(socket);
    }
  }

  nsp.on('connection', async (socket) => {
    const { meetingId, staff } = socket.data;
    const room = roomOf(meetingId);

    // ---- Nex (só equipe; o serviço confere staff/admitted de novo) ----
    if (nex && staff) {
      socket.on('nex:audio', (meta, audio) => {
        nex.handleAudio(socket, meta, audio).catch((err) => app.log.warn({ err: err.message }, 'Nex: falha ao receber áudio'));
      });
      const answer = (fn) => async (_payload, ack) => {
        const result = await fn().catch((err) => ({ error: err.message }));
        if (typeof ack === 'function') ack(result ?? {});
      };
      socket.on('nex:snapshot', answer(() => nex.snapshot(meetingId)));
      socket.on('nex:pause', (payload, ack) => answer(() => nex.setPaused(socket, Boolean(payload?.paused)))(payload, ack));
      socket.on('nex:analyze', answer(() => nex.analyzeNow(socket)));
      socket.on('nex:propose', answer(() => nex.propose(socket)));
      socket.on('nex:save-deal', answer(() => nex.saveToDeal(socket)));
    }

    // Só aceita sinalização para alguém da MESMA sala (nunca para um socket qualquer).
    socket.on('meet:signal', ({ to, data } = {}) => {
      const target = nsp.sockets.get(String(to));
      if (!socket.data.admitted || !target?.rooms.has(room) || !data) return;
      target.emit('meet:signal', { from: socket.id, data });
    });

    socket.on('meet:media', (media = {}) => {
      socket.data.media = { mic: Boolean(media.mic), cam: Boolean(media.cam), screen: Boolean(media.screen) };
      socket.to(room).emit('meet:media', { id: socket.id, media: socket.data.media });
    });

    socket.on('meet:recording', ({ on } = {}) => {
      if (!staff || !socket.data.admitted) return;
      if (on) recording.set(meetingId, { by: socket.data.name, socketId: socket.id });
      else recording.delete(meetingId);
      nsp.to(room).emit('meet:recording', on ? { by: socket.data.name } : null);
    });

    socket.on('meet:end', async () => {
      if (!staff) return;
      await updateMeeting(meetingId, { status: 'ended', ended_at: new Date() });
      nex?.onEnded(meetingId).catch(() => {});
      recording.delete(meetingId);
      nsp.to(room).to(lobbyOf(meetingId)).emit('meet:ended', { by: socket.data.name });
      nsp.in(room).disconnectSockets(true);
      nsp.in(lobbyOf(meetingId)).disconnectSockets(true);
    });

    socket.on('disconnect', async () => {
      nex?.onDisconnect(socket);
      // Quem gravava saiu: a gravação acabou com ele (é feita no navegador dele).
      if (recording.get(meetingId)?.socketId === socket.id) {
        recording.delete(meetingId);
        nsp.to(room).emit('meet:recording', null);
      }
      if (!socket.data.admitted) return;
      socket.to(room).emit('meet:peer-left', { id: socket.id });
      const remaining = await nsp.in(room).fetchSockets();
      // Sala vazia volta a "agendada" (dá para reentrar pelo mesmo link); só "Encerrar" fecha.
      if (remaining.length === 0) {
        const current = await findMeetingByCode(socket.data.meeting.code);
        if (current?.status === 'live') await updateMeeting(meetingId, { status: 'scheduled' });
      }
    });

    const inRoom = await nsp.in(room).fetchSockets();
    if (staff || inRoom.some((s) => s.data.staff)) {
      await admit(socket);
      if (staff) await admitLobby(meetingId);
    } else {
      socket.join(lobbyOf(meetingId));
      socket.emit('meet:waiting', { title: socket.data.meeting.title, host_name: socket.data.meeting.host_name });
    }
  });

  return nsp;
}
