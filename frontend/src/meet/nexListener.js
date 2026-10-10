/**
 * Ouvido do Nex na reunião (só no navegador de quem conduz): grava o áudio de CADA participante
 * em separado, em pedaços de ~15 s, e entrega cada pedaço ao servidor (Whisper).
 *
 *  - Separado por pessoa: a transcrição já sai com quem disse o quê (vendedor × cliente), sem o
 *    modelo ter de adivinhar.
 *  - Pedaços independentes: o MediaRecorder recomeça a cada pedaço (com timeslice, só o 1.º
 *    pedaço teria o cabeçalho do ficheiro e os outros não se decodificavam sozinhos).
 *  - O silêncio é filtrado no SERVIDOR (VAD do faster-whisper, rápido). Aqui só não se envia
 *    quando o microfone esteve desligado o pedaço inteiro. Medir o volume no navegador (Web Audio)
 *    não é fiável: no Chrome o áudio remoto pode chegar mudo ao Web Audio e o Nex descartava a
 *    fala do cliente. Silêncio em opus pesa ~1–3 KB: enviá-lo custa quase nada.
 */

const CHUNK_MS = 15_000;
const CHECK_MS = 500;
const MIN_BYTES = 2_000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

const pickMime = () => (typeof MediaRecorder === 'undefined' ? null : MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null);

export const nexListenerSupported = () => Boolean(pickMime());

/**
 * @param {object} opts
 * @param {() => Array<{ key: string, stream: MediaStream|null }>} opts.getSources "self" e os ids dos participantes
 * @param {(meta: { source: string, offsetMs: number, mime: string }, audio: ArrayBuffer) => void} opts.onChunk
 */
export function createNexListener({ getSources, onChunk, chunkMs = CHUNK_MS }) {
  const mime = pickMime();
  let cycleTimer = null;
  let checkTimer = null;
  let entries = [];
  let t0 = 0;

  function startEntry({ key, stream }) {
    const track = stream?.getAudioTracks().find((t) => t.readyState === 'live');
    if (!track) return null;
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: 32_000 });
    } catch {
      return null;
    }
    const entry = { key, track, recorder, parts: [], live: false, startedAt: Date.now() };
    recorder.ondataavailable = (e) => e.data?.size && entry.parts.push(e.data);
    recorder.start();
    return entry;
  }

  /** Microfone ligado em algum momento do pedaço? (desligado = track.enabled false / muted) */
  function check() {
    for (const entry of entries) if (entry.track.enabled && !entry.track.muted) entry.live = true;
  }

  function finishEntry(entry) {
    return new Promise((resolve) => {
      const done = async () => {
        if (entry.live && entry.parts.length) {
          const blob = new Blob(entry.parts, { type: mime });
          if (blob.size >= MIN_BYTES) onChunk({ source: entry.key, offsetMs: entry.startedAt - t0, mime }, await blob.arrayBuffer());
        }
        resolve();
      };
      if (entry.recorder.state === 'inactive') return done();
      entry.recorder.onstop = done;
      try {
        entry.recorder.stop();
      } catch {
        done();
      }
    });
  }

  function cycle() {
    check();
    const finished = entries;
    entries = getSources().map(startEntry).filter(Boolean);
    finished.forEach((e) => finishEntry(e).catch(() => {}));
  }

  return {
    start() {
      if (!mime || cycleTimer) return false;
      t0 = Date.now();
      entries = getSources().map(startEntry).filter(Boolean);
      cycleTimer = setInterval(cycle, chunkMs);
      checkTimer = setInterval(check, CHECK_MS);
      return true;
    },

    /** Para e envia o último pedaço. */
    async stop() {
      clearInterval(cycleTimer);
      clearInterval(checkTimer);
      cycleTimer = null;
      check();
      const finished = entries;
      entries = [];
      await Promise.all(finished.map((e) => finishEntry(e).catch(() => {})));
    },
  };
}
