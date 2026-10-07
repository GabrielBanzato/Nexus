import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  Circle,
  Copy,
  LoaderCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radar,
  Square,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import { getToken, getTokenPayload } from '../lib/session.js';
import { createMeetingRecorder, downloadRecording, recordingSupported } from './recorder.js';
import { useMeshCall } from './useMeshCall.js';

/**
 * Sala de videochamada (/sala/<código>), fora do login: o cliente entra só com o link.
 * A equipe é reconhecida pelo token guardado no navegador (entra direto e pode gravar/encerrar).
 */

const API_URL = import.meta.env.VITE_API_URL ?? '';
const NAME_KEY = 'nexus:meetName';
const cx = (...c) => c.filter(Boolean).join(' ');

const ERRORS = {
  NOT_FOUND: { title: 'Sala não encontrada', text: 'Confira o link que recebeu. Se o problema continuar, peça um novo link a quem o convidou.' },
  ENDED: { title: 'Esta reunião terminou', text: 'A sala foi encerrada. Se precisar, peça um novo link a quem o convidou.' },
  NAME_REQUIRED: { title: 'Indique o seu nome', text: 'Volte e escreva o seu nome para entrar.' },
};

function readName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function Shell({ title, children }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#0e0e0e] bg-[radial-gradient(ellipse_80%_40%_at_50%_-10%,rgba(127,29,29,0.22),transparent)] text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-800/80 px-4 py-3 sm:px-6">
        <span className="flex size-8 items-center justify-center rounded-lg bg-linear-to-br from-red-700 to-red-950 ring-1 ring-red-600/30">
          <Radar className="size-4 text-white" />
        </span>
        <span className="font-bold tracking-tight">
          Nexus<span className="text-red-600">.</span>
        </span>
        {title && <span className="ml-2 truncate border-l border-neutral-800 pl-3 text-sm text-neutral-400">{title}</span>}
      </header>
      {children}
    </div>
  );
}

function Centered({ icon: Icon = CircleAlert, tone = 'neutral', title, text, children }) {
  const tones = { neutral: 'bg-neutral-800/70 text-neutral-300', red: 'bg-red-950/60 text-red-300', sky: 'bg-sky-950/60 text-sky-300' };
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <span className={cx('mx-auto flex size-14 items-center justify-center rounded-2xl', tones[tone])}>
          <Icon className={cx('size-7', Icon === LoaderCircle && 'animate-spin')} />
        </span>
        <h1 className="mt-4 text-xl font-semibold text-white">{title}</h1>
        {text && <p className="mt-2 text-sm text-neutral-400">{text}</p>}
        {children && <div className="mt-6">{children}</div>}
      </div>
    </main>
  );
}

/**
 * <video> ligado a um MediaStream (srcObject não é atributo React). `onElement` entrega o
 * elemento a quem precisa dele (o gravador desenha a partir destes <video>).
 */
function StreamVideo({ stream, muted, mirrored, onElement, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream ?? null;
  });
  return (
    <video
      ref={(el) => {
        ref.current = el;
        onElement?.(el);
      }}
      autoPlay
      playsInline
      muted={muted}
      className={cx('size-full object-cover', mirrored && '-scale-x-100', className)}
    />
  );
}

function Tile({ name, stream, camOff, micOff, mirrored, isSelf, state, onElement, spotlight }) {
  const connecting = !isSelf && state && state !== 'connected';
  return (
    <div className={cx('relative overflow-hidden rounded-2xl bg-[#1a1a1a] ring-1 ring-neutral-800', spotlight ? 'min-h-0' : 'aspect-video')}>
      <StreamVideo stream={stream} muted={isSelf} mirrored={mirrored} onElement={onElement} className={camOff ? 'invisible' : ''} />
      {camOff && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-20 items-center justify-center rounded-full bg-linear-to-br from-red-700 to-red-950 text-3xl font-bold text-white">
            {(name || '?').trim().charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      {connecting && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-neutral-200">
          <LoaderCircle className="size-4 animate-spin" />
          {state === 'failed' || state === 'disconnected' ? 'Ligação instável, a tentar de novo...' : 'A ligar...'}
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-xs font-medium text-white backdrop-blur">
        {micOff && <MicOff className="size-3.5 text-red-400" />}
        {name}
        {isSelf && <span className="text-neutral-400">(você)</span>}
      </div>
    </div>
  );
}

function ControlButton({ on, onClick, iconOn: IconOn, iconOff: IconOff, label, danger, disabled }) {
  const Icon = on ? IconOn : IconOff;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={on}
      className={cx(
        'flex size-12 items-center justify-center rounded-full transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40',
        danger ? 'bg-red-700 text-white hover:bg-red-600' : on ? 'bg-neutral-800 text-white hover:bg-neutral-700' : 'bg-red-950/80 text-red-300 ring-1 ring-red-800 hover:bg-red-900/80',
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}

/** Pede câmara + micro; sem câmara tenta só áudio; sem nada entra só a ouvir. */
async function getLocalMedia() {
  const attempts = [
    { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } },
    { audio: { echoCancellation: true, noiseSuppression: true }, video: false },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia(constraints), error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { stream: null, error: lastError };
}

export default function MeetingRoom({ code }) {
  const token = getToken();
  const staffName = getTokenPayload()?.name ?? null;
  const [info, setInfo] = useState(null); // dados públicos da sala
  const [infoError, setInfoError] = useState(null);
  const [name, setName] = useState(() => staffName ?? readName());
  const [stage, setStage] = useState('prejoin'); // prejoin | call | left
  const [localStream, setLocalStream] = useState(null);
  const [mediaError, setMediaError] = useState(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [screen, setScreen] = useState(null); // MediaStreamTrack do ecrã partilhado
  const [recorder, setRecorder] = useState(null);
  const [savedRecording, setSavedRecording] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joinedAt, setJoinedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const videoEls = useRef(new Map()); // id → <video>, para o gravador desenhar
  const selfVideoRef = useRef(null);

  const call = useMeshCall({ code, name: name.trim(), token, localStream, enabled: stage === 'call' });
  const { phase, peers, self, recording } = call;

  // Dados públicos da sala (título, anfitrião) para o ecrã de entrada.
  useEffect(() => {
    fetch(`${API_URL}/api/public/meetings/${encodeURIComponent(code)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 404 ? 'NOT_FOUND' : body.message || 'ERROR');
        return body.data;
      })
      .then((data) => (data.status === 'ended' ? setInfoError('ENDED') : setInfo(data)))
      .catch((err) => setInfoError(err.message in ERRORS ? err.message : 'ERROR'));
  }, [code]);

  // Câmara/micro para a pré-visualização (e para a chamada).
  useEffect(() => {
    let stream = null;
    let cancelled = false;
    getLocalMedia().then(({ stream: s, error }) => {
      if (cancelled) return s?.getTracks().forEach((t) => t.stop());
      stream = s;
      setLocalStream(s);
      if (!s?.getVideoTracks().length) setCam(false);
      if (!s) setMic(false);
      if (error && !s) setMediaError(error.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      else if (error) setMediaError('no-camera');
    });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    localStream?.getAudioTracks().forEach((t) => (t.enabled = mic));
  }, [mic, localStream]);
  useEffect(() => {
    localStream?.getVideoTracks().forEach((t) => (t.enabled = cam));
  }, [cam, localStream]);
  useEffect(() => {
    if (phase === 'in-call') call.sendMedia({ mic, cam: cam || Boolean(screen), screen: Boolean(screen) });
  }, [phase, mic, cam, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase === 'in-call' && !joinedAt) setJoinedAt(Date.now());
    if (phase !== 'in-call') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, joinedAt]);

  // ---- Gravação (no navegador de quem conduz) ------------------------------------
  const stopRecording = useCallback(async () => {
    if (!recorder) return;
    const active = recorder;
    setRecorder(null);
    call.setRecordingState(false);
    const blob = await active.stop();
    if (blob?.size) {
      downloadRecording(blob, info?.title);
      setSavedRecording(true);
    }
  }, [recorder, call, info?.title]);

  const tilesRef = useRef([]);
  const startRecording = async () => {
    const rec = createMeetingRecorder({
      getTiles: () => tilesRef.current,
      getAudioStreams: () => [localStream, ...peers.map((p) => p.stream)].filter(Boolean),
    });
    await rec.start();
    setRecorder(rec);
    setSavedRecording(false);
    call.setRecordingState(true);
  };

  // Sair/encerrar com gravação ativa: guarda o ficheiro antes de fechar.
  useEffect(() => {
    if (recorder && ['ended', 'left', 'error'].includes(phase)) stopRecording();
  }, [phase, recorder, stopRecording]);

  // ---- Partilha de ecrã -------------------------------------------------------------
  const stopScreen = useCallback(async () => {
    screen?.stop();
    setScreen(null);
    await call.setOutgoingVideo(localStream?.getVideoTracks()[0] ?? null);
  }, [screen, call, localStream]);

  const startScreen = async () => {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = display.getVideoTracks()[0];
      track.onended = () => {
        setScreen(null);
        call.setOutgoingVideo(localStream?.getVideoTracks()[0] ?? null);
      };
      setScreen(track);
      await call.setOutgoingVideo(track);
    } catch {
      // utilizador cancelou a escolha do ecrã
    }
  };

  const leave = async () => {
    await stopRecording();
    screen?.stop();
    call.leave();
    setStage('left');
  };

  const join = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      if (!staffName) localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      // storage bloqueado: só não lembra o nome
    }
    setStage('call');
  };

  // Um só MediaStream por ecrã partilhado (recriá-lo a cada render reiniciava o <video>).
  const screenStream = useMemo(() => (screen ? new MediaStream([screen]) : null), [screen]);

  // Mosaico: eu + participantes; quem partilha ecrã ganha destaque.
  const tiles = useMemo(() => {
    const list = [
      {
        id: 'self',
        name: self?.name ?? name,
        stream: screenStream ?? localStream,
        camOff: !screen && (!cam || !localStream?.getVideoTracks().length),
        micOff: !mic,
        mirrored: !screen,
        isSelf: true,
        screen: Boolean(screen),
      },
      ...peers.map((p) => ({
        id: p.id,
        name: p.name,
        stream: p.stream,
        camOff: p.media ? !p.media.cam : false,
        micOff: p.media ? !p.media.mic : false,
        state: p.state,
        screen: Boolean(p.media?.screen),
      })),
    ];
    return list;
  }, [self, name, screen, screenStream, localStream, cam, mic, peers]);

  tilesRef.current = tiles.map((t) => ({ video: t.isSelf ? selfVideoRef.current : videoEls.current.get(t.id) ?? null, name: t.name, camOff: t.camOff }));

  // ---- Ecrãs -----------------------------------------------------------------------
  const errorKey = infoError ?? (phase === 'error' || phase === 'ended' ? call.error ?? (phase === 'ended' ? 'ENDED' : null) : null);

  if (phase === 'ended' && stage === 'call') {
    return (
      <Shell title={info?.title}>
        <Centered icon={PhoneOff} title="A reunião terminou" text={call.endedBy ? `Encerrada por ${call.endedBy}.` : undefined}>
          {savedRecording && <p className="text-sm text-emerald-300">A gravação foi guardada no seu computador.</p>}
        </Centered>
      </Shell>
    );
  }
  if (errorKey && ERRORS[errorKey]) {
    return (
      <Shell title={info?.title}>
        <Centered title={ERRORS[errorKey].title} text={ERRORS[errorKey].text} />
      </Shell>
    );
  }
  if (infoError) {
    return (
      <Shell>
        <Centered title="Não foi possível abrir a sala" text="Verifique a sua ligação à internet e tente de novo." />
      </Shell>
    );
  }
  if (stage === 'left') {
    return (
      <Shell title={info?.title}>
        <Centered icon={PhoneOff} title="Você saiu da reunião">
          {savedRecording && <p className="mb-4 text-sm text-emerald-300">A gravação foi guardada no seu computador.</p>}
          <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-red-800 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700">
            Voltar a entrar
          </button>
        </Centered>
      </Shell>
    );
  }
  if (phase === 'full') {
    return (
      <Shell title={info?.title}>
        <Centered icon={Users} title="A sala está cheia" text="Esta reunião já tem o número máximo de participantes. Tente de novo daqui a pouco." />
      </Shell>
    );
  }

  // ---- Entrada (pré-visualização) ---------------------------------------------------
  if (stage === 'prejoin' || phase === 'connecting' || phase === 'idle' || phase === 'waiting') {
    const waiting = phase === 'waiting';
    const connecting = stage === 'call' && !waiting;
    return (
      <Shell title={info?.title}>
        <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-8 p-4 sm:p-8 lg:grid-cols-[3fr_2fr]">
          <div className="relative aspect-video overflow-hidden rounded-2xl bg-[#1a1a1a] ring-1 ring-neutral-800">
            <StreamVideo stream={localStream} muted mirrored className={!cam ? 'invisible' : ''} />
            {!cam && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
                {localStream?.getVideoTracks().length ? 'Câmara desligada' : 'Sem câmara'}
              </div>
            )}
            <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
              <ControlButton on={mic} onClick={() => setMic((m) => !m)} iconOn={Mic} iconOff={MicOff} label={mic ? 'Desligar microfone' : 'Ligar microfone'} disabled={!localStream?.getAudioTracks().length} />
              <ControlButton on={cam} onClick={() => setCam((c) => !c)} iconOn={Video} iconOff={VideoOff} label={cam ? 'Desligar câmara' : 'Ligar câmara'} disabled={!localStream?.getVideoTracks().length} />
            </div>
          </div>

          <form onSubmit={join} className="space-y-5">
            <div>
              <p className="text-sm text-neutral-400">{waiting ? 'Na sala de espera' : 'Pronto para entrar?'}</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">{info?.title ?? 'Reunião'}</h1>
              {info?.host_name && <p className="mt-1 text-sm text-neutral-400">com {info.host_name}</p>}
            </div>

            {mediaError === 'denied' && (
              <p className="rounded-xl bg-amber-950/40 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-900/50">
                O navegador bloqueou a câmara e o microfone. Clique no cadeado da barra de endereço, permita e recarregue a página.
              </p>
            )}
            {mediaError === 'unavailable' && (
              <p className="rounded-xl bg-amber-950/40 px-3 py-2 text-sm text-amber-200 ring-1 ring-amber-900/50">Não encontrámos câmara nem microfone: vai entrar só a ver e ouvir.</p>
            )}
            {mediaError === 'no-camera' && <p className="text-sm text-neutral-400">Sem câmara disponível: vai entrar só com áudio.</p>}

            {waiting ? (
              <div className="flex items-center gap-3 rounded-xl bg-sky-950/40 px-4 py-3 text-sm text-sky-200 ring-1 ring-sky-900/50" role="status">
                <LoaderCircle className="size-4 shrink-0 animate-spin" />
                Aguarde: vai entrar assim que alguém da equipe abrir a sala.
              </div>
            ) : (
              <>
                {!staffName && (
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-neutral-300">O seu nome</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      autoFocus
                      required
                      disabled={connecting}
                      placeholder="Como quer aparecer na reunião"
                      className="h-11 w-full rounded-xl border border-neutral-800 bg-[#141414] px-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-red-700 focus:ring-4 focus:ring-red-900/30"
                    />
                  </label>
                )}
                <button
                  type="submit"
                  disabled={!name.trim() || connecting || !info}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-800 text-sm font-semibold text-white shadow-lg shadow-red-950/40 transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {connecting && <LoaderCircle className="size-4 animate-spin" />}
                  {connecting ? 'A entrar...' : 'Entrar na reunião'}
                </button>
                {staffName && <p className="text-xs text-neutral-500">Vai entrar como {staffName} (equipe).</p>}
              </>
            )}
          </form>
        </main>
      </Shell>
    );
  }

  // ---- Chamada ------------------------------------------------------------------------
  const spotlight = tiles.find((t) => t.screen);
  const others = spotlight ? tiles.filter((t) => t !== spotlight) : tiles;
  const elapsed = joinedAt ? Math.floor((now - joinedAt) / 1000) : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const isStaff = Boolean(self?.staff);
  const tileProps = (t) => ({
    ...t,
    onElement: (el) => {
      if (t.isSelf) selfVideoRef.current = el;
      else if (el) videoEls.current.set(t.id, el);
      else videoEls.current.delete(t.id);
    },
  });

  return (
    <Shell title={info?.title}>
      {recording && (
        <div className="flex items-center justify-center gap-2 bg-red-950/80 px-4 py-1.5 text-xs font-medium text-red-100" role="status">
          <Circle className="size-2.5 animate-pulse fill-red-500 text-red-500" />
          Esta reunião está a ser gravada por {recording.by}.
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
        {spotlight ? (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_16rem]">
            <Tile {...tileProps(spotlight)} spotlight />
            <div className="grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {others.map((t) => <Tile key={t.id} {...tileProps(t)} />)}
            </div>
          </div>
        ) : (
          <div className={cx('mx-auto grid w-full flex-1 content-center gap-3', tiles.length === 1 ? 'max-w-4xl' : 'max-w-6xl sm:grid-cols-2')}>
            {tiles.map((t, i) => (
              // 3 participantes: o terceiro centrado na segunda linha.
              <div key={t.id} className={cx(tiles.length === 3 && i === 2 && 'sm:col-span-2 sm:mx-auto sm:w-1/2')}>
                <Tile {...tileProps(t)} />
              </div>
            ))}
          </div>
        )}
        {peers.length === 0 && (
          <p className="text-center text-sm text-neutral-400">
            Aguardando os outros participantes...{' '}
            {isStaff && (
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true))}
                className="inline-flex items-center gap-1 font-medium text-red-400 hover:text-red-300"
              >
                <Copy className="size-3.5" />
                {copied ? 'Link copiado!' : 'Copiar link da sala'}
              </button>
            )}
          </p>
        )}
      </main>

      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-neutral-800/80 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="mr-auto hidden text-sm text-neutral-400 tabular-nums sm:block">{clock}</span>
        <ControlButton on={mic} onClick={() => setMic((m) => !m)} iconOn={Mic} iconOff={MicOff} label={mic ? 'Desligar microfone' : 'Ligar microfone'} disabled={!localStream?.getAudioTracks().length} />
        <ControlButton on={cam} onClick={() => setCam((c) => !c)} iconOn={Video} iconOff={VideoOff} label={cam ? 'Desligar câmara' : 'Ligar câmara'} disabled={!localStream?.getVideoTracks().length || Boolean(screen)} />
        {/* Partilha de ecrã: não existe nos navegadores de telemóvel. */}
        {navigator.mediaDevices?.getDisplayMedia && (
          <ControlButton on={!screen} onClick={screen ? stopScreen : startScreen} iconOn={MonitorUp} iconOff={MonitorUp} label={screen ? 'Parar de partilhar o ecrã' : 'Partilhar ecrã'} />
        )}
        {isStaff && recordingSupported() && (
          <button
            type="button"
            onClick={recorder ? stopRecording : startRecording}
            title={recorder ? 'Parar gravação (o ficheiro é guardado no seu computador)' : 'Gravar (todos são avisados; o ficheiro fica no seu computador)'}
            className={cx(
              'flex h-12 items-center gap-2 rounded-full px-4 text-sm font-semibold transition active:scale-95',
              recorder ? 'bg-red-700 text-white hover:bg-red-600' : 'bg-neutral-800 text-white hover:bg-neutral-700',
            )}
          >
            {recorder ? <Square className="size-4 fill-white" /> : <Circle className="size-4 fill-red-500 text-red-500" />}
            {recorder ? 'Parar gravação' : 'Gravar'}
          </button>
        )}
        <ControlButton danger onClick={leave} iconOn={PhoneOff} iconOff={PhoneOff} label="Sair da reunião" />
        {isStaff && (
          <button
            type="button"
            onClick={async () => {
              await stopRecording();
              call.endForAll();
            }}
            className="ml-auto hidden h-10 rounded-xl px-3 text-sm font-medium text-red-300 ring-1 ring-red-900/70 hover:bg-red-950/50 sm:block"
          >
            Encerrar para todos
          </button>
        )}
      </footer>
      {recorder && <p className="pb-2 text-center text-[11px] text-neutral-500">A gravar: mantenha esta aba aberta até terminar.</p>}
    </Shell>
  );
}
