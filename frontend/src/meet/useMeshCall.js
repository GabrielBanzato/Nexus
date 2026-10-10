import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

/**
 * Videochamada WebRTC P2P em malha (até 3 pessoas): uma RTCPeerConnection por participante.
 * O servidor (namespace Socket.io "/meet") só troca ofertas/respostas e candidatos ICE.
 *
 * Decisões que evitam os bugs clássicos de WebRTC:
 *  - Quem ENTRA é sempre quem faz a oferta aos que já estão (sem "glare": duas ofertas cruzadas).
 *  - Toda ligação tem SEMPRE 1 transceiver de áudio e 1 de vídeo desde o início, mesmo com a
 *    câmara desligada. Ligar/desligar câmara e partilhar ecrã = replaceTrack, SEM renegociar.
 *  - Quem responde não cria transceivers antes da oferta (senão ficavam fora da negociação e o
 *    seu vídeo não seguia): aplica a oferta e só depois liga as suas faixas aos transceivers.
 *  - Candidatos ICE que chegam antes da descrição remota ficam em fila.
 *
 * @param {object} opts
 * @param {string} opts.code        Código da sala.
 * @param {string} opts.name        Nome (convidado); a equipe é identificada pelo token.
 * @param {string|null} opts.token  JWT da equipe (null = convidado).
 * @param {MediaStream|null} opts.localStream
 * @param {boolean} opts.enabled    false = ainda no ecrã de entrada (não liga).
 */
/**
 * Diagnóstico: /sala/<código>?relay=1 força TODO o tráfego pelo TURN. Se a chamada funcionar
 * assim, o relé (coturn + TURN_URLS/TURN_SECRET) está bem configurado.
 */
const FORCE_RELAY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('relay');

export function useMeshCall({ code, name, token, localStream, enabled }) {
  const [phase, setPhase] = useState('idle'); // idle | connecting | waiting | in-call | full | ended | error
  const [error, setError] = useState(null);
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState({}); // id → { id, name, staff, media, stream, state }
  const [recording, setRecording] = useState(null); // { by } | null
  const [endedBy, setEndedBy] = useState(null);
  // Nex: disponível neste servidor? A transcrever agora? (todos veem o aviso, como na gravação)
  const [nex, setNex] = useState({ available: false, listening: false });
  const [socket, setSocket] = useState(null); // o painel do Nex escuta os eventos dele

  const socketRef = useRef(null);
  const pcs = useRef(new Map()); // id → { pc, stream, pending: RTCIceCandidateInit[] }
  // Nome/papel anunciados pelo servidor (meet:peer-joined) antes de a oferta desse peer chegar.
  const peerInfo = useRef(new Map());
  const iceServersRef = useRef([]);
  const localRef = useRef(localStream);
  const videoTrackRef = useRef(null); // faixa de vídeo a enviar agora (câmara ou ecrã)
  localRef.current = localStream;

  const patchPeer = useCallback((id, patch) => {
    setPeers((all) => (all[id] || patch.name ? { ...all, [id]: { ...all[id], id, ...patch } } : all));
  }, []);

  const localTrack = (kind) => (kind === 'video' ? videoTrackRef.current ?? localRef.current?.getVideoTracks()[0] : localRef.current?.getAudioTracks()[0]) ?? null;

  const createPeer = useCallback(
    (peer, initiator) => {
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current, iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all' });
      const stream = new MediaStream();
      const entry = { pc, stream, pending: [] };
      pcs.current.set(peer.id, entry);
      patchPeer(peer.id, { name: peer.name, staff: peer.staff, media: peer.media ?? { mic: true, cam: true }, stream, state: 'connecting' });

      pc.onicecandidate = ({ candidate }) => candidate && socketRef.current?.emit('meet:signal', { to: peer.id, data: { candidate } });
      pc.ontrack = ({ track }) => {
        stream.getTracks().filter((t) => t.kind === track.kind).forEach((t) => stream.removeTrack(t));
        stream.addTrack(track);
        patchPeer(peer.id, { stream, tracksAt: Date.now() }); // força re-render do <video>
      };
      pc.onconnectionstatechange = () => {
        patchPeer(peer.id, { state: pc.connectionState });
        // Rede mudou (ex.: Wi-Fi → 4G): o iniciador renegocia o ICE.
        if (pc.connectionState === 'failed' && initiator) {
          pc.createOffer({ iceRestart: true })
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => socketRef.current?.emit('meet:signal', { to: peer.id, data: { sdp: pc.localDescription } }))
            .catch(() => {});
        }
      };

      if (initiator) {
        for (const kind of ['audio', 'video']) {
          pc.addTransceiver(localTrack(kind) ?? kind, { direction: 'sendrecv', streams: localRef.current ? [localRef.current] : [] });
        }
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => socketRef.current?.emit('meet:signal', { to: peer.id, data: { sdp: pc.localDescription } }))
          .catch((err) => console.error('WebRTC: falha ao criar oferta', err));
      }
      return entry;
    },
    [patchPeer], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleSignal = useCallback(
    async ({ from, data }) => {
      let entry = pcs.current.get(from);
      if (!entry) entry = createPeer(peerInfo.current.get(from) ?? { id: from, name: 'Participante' }, false);
      const { pc } = entry;
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            // Só agora (depois da oferta) liga as faixas locais aos transceivers negociados.
            for (const t of pc.getTransceivers()) {
              const kind = t.receiver.track?.kind;
              t.direction = 'sendrecv';
              const track = kind ? localTrack(kind) : null;
              if (track) await t.sender.replaceTrack(track);
            }
            await pc.setLocalDescription(await pc.createAnswer());
            socketRef.current?.emit('meet:signal', { to: from, data: { sdp: pc.localDescription } });
          }
          for (const candidate of entry.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
          else entry.pending.push(data.candidate);
        }
      } catch (err) {
        console.error('WebRTC: falha na sinalização', err);
      }
    },
    [createPeer], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const closePeer = useCallback((id) => {
    pcs.current.get(id)?.pc.close();
    pcs.current.delete(id);
    peerInfo.current.delete(id);
    setPeers(({ [id]: _gone, ...rest }) => rest);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    setPhase('connecting');
    const socket = io(`${import.meta.env.VITE_API_URL ?? ''}/meet`, {
      path: '/api/socket.io',
      auth: { code, name, token: token ?? undefined },
      forceNew: true,
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;
    setSocket(socket);

    socket.on('connect_error', (err) => {
      if (['NOT_FOUND', 'ENDED', 'NAME_REQUIRED'].includes(err.message)) {
        setError(err.message);
        setPhase(err.message === 'ENDED' ? 'ended' : 'error');
        socket.disconnect();
      }
    });
    socket.on('meet:waiting', () => setPhase('waiting'));
    socket.on('meet:full', () => setPhase('full'));
    socket.on('meet:joined', ({ self: me, peers: existing, iceServers, recording: rec, nex: nexInfo }) => {
      iceServersRef.current = iceServers;
      setSelf(me);
      setRecording(rec);
      if (nexInfo) setNex(nexInfo);
      setPhase('in-call');
      existing.forEach((peer) => createPeer(peer, true)); // quem entra oferece
    });
    socket.on('meet:peer-joined', (peer) => {
      peerInfo.current.set(peer.id, peer);
      patchPeer(peer.id, { ...peer, state: 'connecting' });
    });
    socket.on('meet:signal', handleSignal);
    socket.on('meet:peer-left', ({ id }) => closePeer(id));
    socket.on('meet:media', ({ id, media }) => patchPeer(id, { media }));
    socket.on('meet:recording', (rec) => setRecording(rec));
    socket.on('meet:nex', ({ on }) => setNex((n) => ({ ...n, listening: Boolean(on) })));
    socket.on('meet:ended', ({ by }) => {
      setEndedBy(by);
      setPhase('ended');
    });
    // Ligação de sinalização caiu e voltou: as ligações P2P já estabelecidas continuam.
    socket.on('disconnect', (reason) => reason === 'io server disconnect' && setPhase((p) => (p === 'in-call' ? 'ended' : p)));

    return () => {
      socket.disconnect();
      for (const { pc } of pcs.current.values()) pc.close();
      pcs.current.clear();
      setPeers({});
      setSocket(null);
    };
  }, [enabled, code, name, token, createPeer, handleSignal, closePeer, patchPeer]);

  /**
   * Troca a faixa enviada a todos sem renegociar: câmara ↔ ecrã, ou outra câmara/microfone
   * escolhido nas configurações.
   */
  const replaceOutgoing = useCallback(async (kind, track) => {
    if (kind === 'video') videoTrackRef.current = track;
    for (const { pc } of pcs.current.values()) {
      const sender = pc.getTransceivers().find((t) => t.receiver.track?.kind === kind)?.sender;
      if (sender) await sender.replaceTrack(track).catch(() => {});
    }
  }, []);
  const setOutgoingVideo = useCallback((track) => replaceOutgoing('video', track), [replaceOutgoing]);

  const sendMedia = useCallback((media) => socketRef.current?.emit('meet:media', media), []);
  const setRecordingState = useCallback((on) => socketRef.current?.emit('meet:recording', { on }), []);
  const endForAll = useCallback(() => socketRef.current?.emit('meet:end'), []);
  /** Pedido ao Nex com resposta (ack do Socket.io). */
  const nexRequest = useCallback(
    (event, payload = {}) =>
      new Promise((resolve) => {
        const s = socketRef.current;
        if (!s?.connected) return resolve({ error: 'Sem ligação ao servidor.' });
        s.timeout(120_000).emit(event, payload, (err, result) => resolve(err ? { error: 'O servidor demorou demais a responder.' } : result ?? {}));
      }),
    [],
  );
  const sendNexAudio = useCallback((meta, audio) => socketRef.current?.emit('nex:audio', meta, audio), []);

  const leave = useCallback(() => {
    socketRef.current?.disconnect();
    setPhase('left');
  }, []);

  return { phase, error, self, peers: Object.values(peers).filter((p) => p.stream), recording, endedBy, nex, socket, nexRequest, sendNexAudio, setOutgoingVideo, replaceOutgoing, sendMedia, setRecordingState, endForAll, leave };
}
