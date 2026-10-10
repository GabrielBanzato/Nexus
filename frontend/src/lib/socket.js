import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getToken } from './session.js';

/**
 * Ligação Socket.io partilhada (uma por aba), usada pela Central de Atendimento e pelo painel
 * do WhatsApp. Complementa o SSE de useLiveUpdates: aqui chegam eventos COM dados (mensagens,
 * estado do WhatsApp), já filtrados pelo servidor para quem pode vê-los.
 *
 * Eventos do servidor:
 *  - new_message     { message, client }  mensagem recebida ou enviada (admins + responsável)
 *  - whatsapp:status { status }           estado da sessão (todos)
 *  - whatsapp:state  { status, qr, ... }  estado completo, com QR Code (só admins)
 */

const API_URL = import.meta.env.VITE_API_URL ?? '';
const RECONNECT_AFTER_KICK_MS = 1_000;

let socket = null;

export function getSocket() {
  if (socket) return socket;
  socket = io(API_URL || undefined, {
    path: '/api/socket.io',
    // Função: o token é lido a cada (re)ligação, não fica preso ao do primeiro connect.
    auth: (cb) => cb({ token: getToken() ?? '' }),
  });
  socket.on('disconnect', (reason) => {
    // O servidor derrubou a ligação (papel/acesso mudou, token expirou): o cliente do
    // Socket.io não religa sozinho nesse caso. Religa, e o servidor volta a validar.
    if (reason === 'io server disconnect' && getToken()) setTimeout(() => socket?.connect(), RECONNECT_AFTER_KICK_MS);
  });
  // Recusa no handshake (UNAUTHORIZED) não religa automaticamente: a sessão HTTP trata do logout.
  return socket;
}

/** Fecha a ligação (logout, sessão expirada ou troca de utilizador noutra aba). */
export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

/** Ouve um evento enquanto o componente está montado. O handler pode mudar a cada render. */
export function useSocketEvent(event, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const s = getSocket();
    const listener = (payload) => handlerRef.current(payload);
    s.on(event, listener);
    return () => s.off(event, listener);
  }, [event]);
}

/** true enquanto a ligação em tempo real está aberta. */
export function useSocketConnected() {
  const [connected, setConnected] = useState(() => getSocket().connected);
  useEffect(() => {
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    s.on('connect_error', off);
    setConnected(s.connected);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
      s.off('connect_error', off);
    };
  }, []);
  return connected;
}
