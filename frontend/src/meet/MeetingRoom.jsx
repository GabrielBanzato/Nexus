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
  Settings,
  Sparkles,
  Square,
  Users,
  Video,
  VideoOff,
  Volume1,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import { getToken, getTokenPayload } from '../lib/session.js';
import { createBlurredTrack, nativeBlurSupported, setNativeBlur } from './backgroundBlur.js';
import { createMeetingRecorder, downloadRecording, recordingSupported } from './recorder.js';
import { useMeshCall } from './useMeshCall.js';
import NexPanel from './NexPanel.jsx';

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
function StreamVideo({ stream, muted, volume = 1, mirrored, onElement, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream ?? null;
  });
  // Volume só deste participante, só para quem ouve (no iPhone o volume é do sistema: só mudo).
  // "muted" também à mão: o React nem sempre o aplica ao <video> antes de começar a tocar, e a
  // minha própria voz a sair pelas minhas colunas seria eco para todos.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = Boolean(muted);
    el.volume = Math.min(Math.max(volume, 0), 1);
  }, [muted, volume, stream]);
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

// O navegador deixa mudar o volume de um <video>? (no iPhone/iPad não: é sempre o do sistema)
const volumeAdjustable = (() => {
  try {
    const probe = document.createElement('audio');
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch {
    return false;
  }
})();

/**
 * Volume de UM participante, só para mim (os outros não são afetados): botão no canto do quadro
 * → controlo deslizante 0–100% e "silenciar". No iPhone só há silenciar.
 */
function PeerAudioControl({ name, audio, onChange }) {
  const [open, setOpen] = useState(false);
  const silent = audio.muted || audio.volume === 0;
  const Icon = silent ? VolumeX : audio.volume < 0.5 ? Volume1 : Volume2;
  const toggleMute = () => onChange({ ...audio, muted: !audio.muted, volume: audio.volume || 1 });

  return (
    // z-10: por cima da inicial (câmara desligada) e do aviso "a ligar", que cobrem o quadro todo.
    <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={volumeAdjustable ? () => setOpen((v) => !v) : toggleMute}
        aria-label={volumeAdjustable ? `Volume de ${name}` : silent ? `Voltar a ouvir ${name}` : `Silenciar ${name} para você`}
        title={volumeAdjustable ? 'Volume deste participante (só para você)' : silent ? 'Voltar a ouvir' : 'Silenciar para você'}
        className={cx(
          'flex size-8 items-center justify-center rounded-full backdrop-blur transition',
          silent ? 'bg-red-900/80 text-red-100' : 'bg-black/55 text-white hover:bg-black/75',
        )}
      >
        <Icon className="size-4" />
      </button>
      {open && volumeAdjustable && (
        <div className="flex items-center gap-2 rounded-xl bg-black/80 px-3 py-2 text-xs text-white shadow-lg backdrop-blur">
          <button type="button" onClick={toggleMute} aria-label={audio.muted ? 'Voltar a ouvir' : 'Silenciar'} className="text-neutral-300 hover:text-white">
            {audio.muted ? <VolumeX className="size-4 text-red-300" /> : <Volume2 className="size-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={audio.muted ? 0 : Math.round(audio.volume * 100)}
            onChange={(e) => onChange({ muted: false, volume: Number(e.target.value) / 100 })}
            aria-label={`Volume de ${name}`}
            className="h-1 w-24 cursor-pointer accent-red-500"
          />
          <span className="w-8 text-right tabular-nums">{audio.muted ? 0 : Math.round(audio.volume * 100)}%</span>
        </div>
      )}
    </div>
  );
}

const DEFAULT_AUDIO = { volume: 1, muted: false };

function Tile({ name, stream, camOff, micOff, mirrored, isSelf, state, onElement, spotlight, audio = DEFAULT_AUDIO, onAudioChange }) {
  const connecting = !isSelf && state && state !== 'connected';
  return (
    <div className={cx('relative overflow-hidden rounded-2xl bg-[#1a1a1a] ring-1 ring-neutral-800', spotlight ? 'min-h-0' : 'aspect-video')}>
      <StreamVideo stream={stream} muted={isSelf || audio.muted} volume={audio.volume} mirrored={mirrored} onElement={onElement} className={camOff ? 'invisible' : ''} />
      {!isSelf && onAudioChange && <PeerAudioControl name={name} audio={audio} onChange={onAudioChange} />}
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

/** Liga/desliga o desfoque do fundo (ativo = destacado a azul, não vermelho: não é um "erro"). */
function BlurButton({ on, loading, onClick, disabled }) {
  const label = loading ? 'A preparar o desfoque...' : on ? 'Tirar o desfoque do fundo' : 'Desfocar o fundo';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={label}
      title={label}
      aria-pressed={on}
      className={cx(
        'flex size-12 items-center justify-center rounded-full transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'bg-sky-700 text-white ring-2 ring-sky-400/60 hover:bg-sky-600' : 'bg-neutral-800 text-white hover:bg-neutral-700',
      )}
    >
      {loading ? <LoaderCircle className="size-5 animate-spin" /> : <Sparkles className="size-5" />}
    </button>
  );
}

// Câmara e microfone escolhidos (deviceId), lembrados neste navegador.
const DEVICES_KEY = 'nexus:meetDevices';
function readDevices() {
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveDevice(kind, deviceId) {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ ...readDevices(), [kind]: deviceId }));
  } catch {
    // storage bloqueado: só não lembra a escolha
  }
}

/**
 * Microfone com o tratamento de voz do navegador SEMPRE ligado: cancelamento de eco (tira do
 * microfone o som que sai das colunas — é o que evita os outros ouvirem a própria voz de volta),
 * supressão de ruído e ganho automático. "voiceIsolation" (Chrome recente) isola ainda mais a voz.
 */
const audioConstraints = (deviceId) => ({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true,
  channelCount: 1,
  ...(deviceId && { deviceId }),
});

/** Alguns microfones (ex.: virtuais) abrem sem o cancelamento de eco: tenta forçá-lo. */
async function ensureEchoCancellation(track) {
  if (!track || track.kind !== 'audio') return;
  const settings = track.getSettings?.() ?? {};
  if (settings.echoCancellation === false || settings.noiseSuppression === false) {
    await track.applyConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }).catch(() => {});
  }
}
const videoConstraints = (deviceId) => ({ width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId } : { facingMode: 'user' }) });

/**
 * Pede câmara + micro (os últimos escolhidos, se ainda existirem); sem câmara tenta só áudio;
 * sem nada entra só a ouvir.
 */
async function getLocalMedia() {
  const saved = readDevices();
  const audio = audioConstraints(saved.audio && { ideal: saved.audio });
  const attempts = [
    { audio, video: videoConstraints(saved.video && { ideal: saved.video }) },
    { audio, video: false },
  ];
  let lastError = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      await ensureEchoCancellation(stream.getAudioTracks()[0]);
      return { stream, error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { stream: null, error: lastError };
}

/** Câmaras e microfones do aparelho (os nomes só aparecem depois de dada a permissão). */
function useMediaDevices(ready) {
  const [devices, setDevices] = useState({ audio: [], video: [] });
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!ready || !media?.enumerateDevices) return undefined;
    const load = () =>
      media
        .enumerateDevices()
        .then((list) =>
          setDevices({
            audio: list.filter((d) => d.kind === 'audioinput' && d.deviceId),
            video: list.filter((d) => d.kind === 'videoinput' && d.deviceId),
          }),
        )
        .catch(() => {});
    load();
    media.addEventListener?.('devicechange', load); // ligou/desligou uma câmara ou um headset
    return () => media.removeEventListener?.('devicechange', load);
  }, [ready]);
  return devices;
}

const deviceLabel = (device, index, kind) =>
  device.label || `${kind === 'video' ? 'Câmara' : 'Microfone'} ${index + 1}`;

/** Seletores de câmara e microfone (entrada e durante a chamada). */
function DevicePicker({ devices, current, onChange, busy, error, className }) {
  const select = 'h-10 w-full min-w-0 cursor-pointer rounded-xl border border-neutral-800 bg-[#141414] px-3 text-sm text-neutral-100 outline-none focus:border-red-700 disabled:cursor-wait disabled:opacity-60';
  return (
    <div className={cx('space-y-2', className)}>
      {[
        { kind: 'video', icon: Video, label: 'Câmara', list: devices.video },
        { kind: 'audio', icon: Mic, label: 'Microfone', list: devices.audio },
      ].map(({ kind, icon: Icon, label, list }) => (
        <label key={kind} className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-neutral-400" aria-hidden="true" />
          <span className="sr-only">{label}</span>
          <select
            aria-label={label}
            value={current[kind] ?? ''}
            disabled={busy || list.length === 0}
            onChange={(e) => onChange(kind, e.target.value)}
            className={select}
          >
            {list.length === 0 && <option value="">{kind === 'video' ? 'Nenhuma câmara encontrada' : 'Nenhum microfone encontrado'}</option>}
            {!current[kind] && list.length > 0 && <option value="">Escolha {kind === 'video' ? 'a câmara' : 'o microfone'}</option>}
            {list.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceLabel(d, i, kind)}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error && <p className="text-xs text-amber-300">{error}</p>}
    </div>
  );
}

export default function MeetingRoom({ code }) {
  // Equipe = quem tem sessão do Nexus neste navegador: só ela grava e encerra para todos (o servidor
  // também o garante). ?convidado entra como o cliente entraria, mesmo com sessão (para testar).
  const asGuest = new URLSearchParams(window.location.search).has('convidado');
  const token = asGuest ? null : getToken();
  const staffName = asGuest ? null : getTokenPayload()?.name ?? null;
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
  const [nexOpen, setNexOpen] = useState(false); // telemóvel/ecrã estreito: o painel abre por cima
  const [joinedAt, setJoinedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const videoEls = useRef(new Map()); // id → <video>, para o gravador desenhar
  const selfVideoRef = useRef(null);

  // ---- Desfoque do fundo ------------------------------------------------------------
  // processed: faixa desfocada (MediaPipe) feita a partir da câmara source. Com o desfoque
  // ligado e ainda a preparar, NÃO se envia a câmara crua (o fundo não aparece nem por 1 s).
  const [blurOn, setBlurOn] = useState(() => Boolean(readDevices().blur));
  const [blurLoading, setBlurLoading] = useState(false);
  const [blurNative, setBlurNative] = useState(false);
  const [blurError, setBlurError] = useState(null);
  const [processed, setProcessed] = useState(null);
  const rawVideo = localStream?.getVideoTracks()[0] ?? null;
  const effectiveVideo = !blurOn || blurNative ? rawVideo : processed?.source === rawVideo ? processed.track : null;
  // O que sai de mim: a câmara (ou a desfocada) + o microfone. É também a minha pré-visualização.
  const outStream = useMemo(
    () => (localStream ? new MediaStream([...(effectiveVideo ? [effectiveVideo] : []), ...localStream.getAudioTracks()]) : null),
    [localStream, effectiveVideo],
  );
  const effectiveRef = useRef(effectiveVideo);
  effectiveRef.current = effectiveVideo;

  // Volume de cada participante (só para mim): id → { volume 0–1, muted }.
  const [peerAudio, setPeerAudio] = useState({});

  const call = useMeshCall({ code, name: name.trim(), token, localStream: outStream, enabled: stage === 'call' });
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
  const localStreamRef = useRef(null);
  localStreamRef.current = localStream;
  useEffect(() => {
    let cancelled = false;
    getLocalMedia().then(({ stream: s, error }) => {
      if (cancelled) return s?.getTracks().forEach((t) => t.stop());
      setLocalStream(s);
      if (!s?.getVideoTracks().length) setCam(false);
      if (!s) setMic(false);
      if (error && !s) setMediaError(error.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      else if (error) setMediaError('no-camera');
    });
    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((t) => t.stop()); // a atual (pode já ter trocado de câmara)
    };
  }, []);

  // ---- Escolha de câmara e microfone ------------------------------------------------
  const devices = useMediaDevices(Boolean(localStream));
  const [switching, setSwitching] = useState(false);
  const [deviceError, setDeviceError] = useState(null);
  const [showDevices, setShowDevices] = useState(false);
  const currentDevices = {
    video: localStream?.getVideoTracks()[0]?.getSettings().deviceId ?? null,
    audio: localStream?.getAudioTracks()[0]?.getSettings().deviceId ?? null,
  };

  /**
   * Troca de câmara/microfone a qualquer momento (também a meio da chamada: replaceTrack, sem
   * cair). Se a nova não abrir com a antiga ligada (comum em telemóveis), fecha a antiga e tenta
   * de novo; se mesmo assim falhar, volta à anterior.
   */
  const switchDevice = async (kind, deviceId) => {
    if (!deviceId) return;
    const current = localStreamRef.current;
    const old = kind === 'video' ? current?.getVideoTracks() ?? [] : current?.getAudioTracks() ?? [];
    const previousId = old[0]?.getSettings().deviceId;
    const open = (id) =>
      navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: videoConstraints({ exact: id }) } : { audio: audioConstraints({ exact: id }) });

    setSwitching(true);
    setDeviceError(null);
    let track = null;
    try {
      try {
        track = (await open(deviceId)).getTracks()[0];
      } catch {
        old.forEach((t) => t.stop());
        track = (await open(deviceId)).getTracks()[0];
      }
      saveDevice(kind, deviceId);
    } catch {
      setDeviceError(`Não foi possível usar ${kind === 'video' ? 'esta câmara' : 'este microfone'}. Ela pode estar em uso noutro programa.`);
      if (old.some((t) => t.readyState === 'ended') && previousId) {
        track = (await open(previousId).catch(() => null))?.getTracks()[0] ?? null; // volta à anterior
      }
      if (!track) {
        setSwitching(false);
        return;
      }
    }

    old.forEach((t) => t !== track && t.stop());
    const keep = kind === 'video' ? current?.getAudioTracks() ?? [] : current?.getVideoTracks() ?? [];
    if (kind === 'video') {
      setCam(true);
      setMediaError((e) => (e === 'no-camera' ? null : e));
    } else {
      track.enabled = mic;
      await ensureEchoCancellation(track);
    }
    setLocalStream(new MediaStream([...keep, track]));
    // Na chamada: o novo microfone segue já; o vídeo segue pelo efeito acima (com ou sem desfoque).
    if (kind === 'audio') await call.replaceOutgoing('audio', track);
    setSwitching(false);
  };

  useEffect(() => {
    localStream?.getAudioTracks().forEach((t) => (t.enabled = mic));
  }, [mic, localStream]);
  useEffect(() => {
    localStream?.getVideoTracks().forEach((t) => (t.enabled = cam));
    if (processed) processed.track.enabled = cam;
  }, [cam, localStream, processed]);

  // Liga o desfoque na câmara atual (e refaz-o ao trocar de câmara). Nativo se houver; senão MediaPipe.
  useEffect(() => {
    if (!rawVideo) return undefined;
    if (!blurOn) {
      if (nativeBlurSupported(rawVideo)) setNativeBlur(rawVideo, false).catch(() => {});
      setBlurNative(false);
      return undefined;
    }
    let cancelled = false;
    let created = null;
    (async () => {
      if (nativeBlurSupported(rawVideo)) {
        try {
          await setNativeBlur(rawVideo, true);
          if (!cancelled) setBlurNative(true);
          return;
        } catch {
          // o sistema anuncia mas recusa: segue para o MediaPipe
        }
      }
      setBlurNative(false);
      setBlurLoading(true);
      try {
        const result = await createBlurredTrack(rawVideo);
        if (cancelled) return result.stop();
        created = result;
        result.track.enabled = rawVideo.enabled;
        setProcessed({ ...result, source: rawVideo });
      } catch (err) {
        console.warn('Desfoque indisponível', err);
        if (!cancelled) {
          setBlurError('Não foi possível ativar o desfoque neste aparelho.');
          setBlurOn(false);
        }
      } finally {
        if (!cancelled) setBlurLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      created?.stop();
      setProcessed(null);
    };
  }, [blurOn, rawVideo]);

  const toggleBlur = () => {
    setBlurError(null);
    setBlurOn((on) => {
      saveDevice('blur', !on);
      return !on;
    });
  };

  // Na chamada, a faixa de vídeo enviada segue a efetiva (desfoque ligado/desligado, outra
  // câmara), exceto enquanto se partilha o ecrã.
  useEffect(() => {
    if (phase === 'in-call' && !screen) call.replaceOutgoing('video', effectiveVideo);
  }, [phase, effectiveVideo, screen]); // eslint-disable-line react-hooks/exhaustive-deps
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
    await call.setOutgoingVideo(effectiveRef.current);
  }, [screen, call]);

  const startScreen = async () => {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = display.getVideoTracks()[0];
      track.onended = () => {
        setScreen(null);
        call.setOutgoingVideo(effectiveRef.current);
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
        stream: screenStream ?? outStream,
        camOff: !screen && (!cam || !outStream?.getVideoTracks().length),
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
        audio: peerAudio[p.id] ?? DEFAULT_AUDIO,
        onAudioChange: (audio) => setPeerAudio((all) => ({ ...all, [p.id]: audio })),
      })),
    ];
    return list;
  }, [self, name, screen, screenStream, outStream, cam, mic, peers, peerAudio]);

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
            <StreamVideo stream={outStream} muted mirrored className={!cam || !effectiveVideo ? 'invisible' : ''} />
            {(!cam || !effectiveVideo) && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
                {!localStream?.getVideoTracks().length ? 'Sem câmara' : !cam ? 'Câmara desligada' : 'A preparar o desfoque...'}
              </div>
            )}
            <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
              <ControlButton on={mic} onClick={() => setMic((m) => !m)} iconOn={Mic} iconOff={MicOff} label={mic ? 'Desligar microfone' : 'Ligar microfone'} disabled={!localStream?.getAudioTracks().length} />
              <ControlButton on={cam} onClick={() => setCam((c) => !c)} iconOn={Video} iconOff={VideoOff} label={cam ? 'Desligar câmara' : 'Ligar câmara'} disabled={!localStream?.getVideoTracks().length} />
              <BlurButton on={blurOn} loading={blurLoading} onClick={toggleBlur} disabled={!rawVideo} />
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
            {blurError && <p className="text-sm text-amber-300">{blurError}</p>}

            {(localStream || deviceError) && (
              <DevicePicker devices={devices} current={currentDevices} onChange={switchDevice} busy={switching} error={deviceError} />
            )}

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
                {staffName && (
                  <p className="text-xs text-neutral-500">
                    Vai entrar como {staffName} (equipe): só a equipe pode gravar e encerrar para todos.{' '}
                    <a href={`?convidado=1`} target="_blank" rel="noopener noreferrer" className="font-medium text-neutral-400 underline hover:text-white">
                      Ver como o cliente vê
                    </a>
                  </p>
                )}
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
      {call.nex.listening && (
        <div className="flex items-center justify-center gap-2 bg-violet-950/70 px-4 py-1.5 text-xs font-medium text-violet-100" role="status">
          <Wand2 className="size-3.5" />
          O assistente Nex está a transcrever esta conversa para apoiar o atendimento.
        </div>
      )}
      {recording && (
        <div className="flex items-center justify-center gap-2 bg-red-950/80 px-4 py-1.5 text-xs font-medium text-red-100" role="status">
          <Circle className="size-2.5 animate-pulse fill-red-500 text-red-500" />
          Esta reunião está a ser gravada por {recording.by}.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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

          {showDevices && (
            <div className="mx-auto mb-2 w-full max-w-sm rounded-2xl bg-[#1a1a1a] p-3 shadow-2xl ring-1 ring-neutral-800">
              <p className="mb-2 text-xs font-semibold text-neutral-300">Câmara e microfone</p>
              <DevicePicker devices={devices} current={currentDevices} onChange={switchDevice} busy={switching} error={deviceError} />
            </div>
          )}
          <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-neutral-800/80 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="mr-auto hidden text-sm text-neutral-400 tabular-nums sm:block">{clock}</span>
            <ControlButton on={mic} onClick={() => setMic((m) => !m)} iconOn={Mic} iconOff={MicOff} label={mic ? 'Desligar microfone' : 'Ligar microfone'} disabled={!localStream?.getAudioTracks().length} />
            <ControlButton on={cam} onClick={() => setCam((c) => !c)} iconOn={Video} iconOff={VideoOff} label={cam ? 'Desligar câmara' : 'Ligar câmara'} disabled={!localStream?.getVideoTracks().length || Boolean(screen)} />
            <BlurButton on={blurOn} loading={blurLoading} onClick={toggleBlur} disabled={!rawVideo || Boolean(screen)} />
            {localStream && (
              <ControlButton on={!showDevices} onClick={() => setShowDevices((v) => !v)} iconOn={Settings} iconOff={Settings} label="Escolher câmara e microfone" />
            )}
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
            {isStaff && (
              <button
                type="button"
                onClick={() => setNexOpen((v) => !v)}
                aria-label="Abrir o Nex"
                title="Nex: pontos da negociação"
                className={cx('flex size-12 items-center justify-center rounded-full transition active:scale-95 lg:hidden', nexOpen ? 'bg-violet-700 text-white' : 'bg-neutral-800 text-violet-300 hover:bg-neutral-700')}
              >
                <Wand2 className="size-5" />
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
          {blurError && <p className="pb-2 text-center text-xs text-amber-300">{blurError}</p>}
        </div>
        {/* Nex: coluna fixa à direita no computador; no telemóvel abre por cima (botão na barra). */}
        {isStaff && (
          <NexPanel
            call={call}
            localStream={localStream}
            peers={peers}
            onClose={() => setNexOpen(false)}
            className={cx('w-full max-w-sm lg:static lg:flex lg:w-[22rem] lg:max-w-none', nexOpen ? 'fixed inset-y-0 right-0 z-40 flex shadow-2xl' : 'hidden')}
          />
        )}
      </div>
    </Shell>
  );
}
