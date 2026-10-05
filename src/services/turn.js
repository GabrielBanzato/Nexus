import { createHmac } from 'node:crypto';
import { config } from '../config/env.js';

const TTL_SECONDS = 6 * 60 * 60; // dura mais que qualquer reunião

/**
 * Servidores ICE para o RTCPeerConnection do navegador.
 *  - STUN: descobre o IP público (resolve a maioria das ligações diretas).
 *  - TURN (coturn): retransmite quando o P2P é bloqueado (redes corporativas, 4G com CGNAT...).
 *    Credenciais TEMPORÁRIAS pelo esquema "TURN REST API" do coturn (--use-auth-secret):
 *    username = "<expira>:<id>", senha = HMAC-SHA1(segredo, username). O segredo nunca sai do
 *    servidor e uma credencial vazada deixa de valer em poucas horas.
 */
export function iceServers(identity) {
  const servers = [];
  if (config.meet.stunUrls.length) servers.push({ urls: config.meet.stunUrls });
  if (config.meet.turnUrls.length && config.meet.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${String(identity).replace(/:/g, '')}`;
    const credential = createHmac('sha1', config.meet.turnSecret).update(username).digest('base64');
    servers.push({ urls: config.meet.turnUrls, username, credential });
  }
  return servers;
}
