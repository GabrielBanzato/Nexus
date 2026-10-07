/**
 * Gravação da reunião NO NAVEGADOR de quem conduz (zero custo para o servidor).
 *
 * Vídeo: um <canvas> desenha os participantes em grelha (30 fps) → canvas.captureStream().
 * Áudio: Web Audio mistura o microfone local e o áudio de cada participante → um só canal.
 * MediaRecorder grava os dois; no fim sai um ficheiro (.webm no Chrome/Edge/Firefox, .mp4 no Safari).
 *
 * O "relógio" de quadros corre num Web Worker: timers da página principal são travados (≈1/s)
 * quando a aba fica em segundo plano, o que congelaria a gravação.
 */

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const MIME_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

export const recordingSupported = () =>
  typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && MIME_TYPES.some((t) => MediaRecorder.isTypeSupported(t));

/** Relógio num Web Worker: continua a bater com a aba em segundo plano (também usado pelo desfoque). */
export const tickerWorker = () => {
  const src = `let id; onmessage = (e) => { clearInterval(id); if (e.data > 0) id = setInterval(() => postMessage(0), e.data); };`;
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
};

/** Desenha o vídeo a preencher a célula, cortando o excesso (como object-fit: cover). */
function drawCover(ctx, video, x, y, w, h) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
  return true;
}

/**
 * @param {() => Array<{ video: HTMLVideoElement|null, name: string, camOff: boolean }>} getTiles
 * @param {() => MediaStream[]} getAudioStreams  microfone local + streams dos participantes
 */
export function createMeetingRecorder({ getTiles, getAudioStreams }) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');

  const audioCtx = new AudioContext();
  const mix = audioCtx.createMediaStreamDestination();
  const connected = new Set(); // ids das faixas de áudio já ligadas à mistura

  const syncAudio = () => {
    for (const stream of getAudioStreams()) {
      for (const track of stream?.getAudioTracks() ?? []) {
        if (connected.has(track.id) || track.readyState !== 'live') continue;
        audioCtx.createMediaStreamSource(new MediaStream([track])).connect(mix);
        connected.add(track.id);
      }
    }
  };

  const draw = () => {
    const tiles = getTiles();
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const cols = tiles.length <= 1 ? 1 : 2;
    const rows = Math.ceil(tiles.length / cols) || 1;
    const gap = 8;
    const w = (WIDTH - gap * (cols + 1)) / cols;
    const h = (HEIGHT - gap * (rows + 1)) / rows;
    tiles.forEach((tile, i) => {
      const row = Math.floor(i / cols);
      // Última linha com uma só pessoa (3 participantes): centra-a.
      const inRow = row === rows - 1 ? tiles.length - row * cols : cols;
      const offset = ((cols - inRow) * (w + gap)) / 2;
      const x = gap + offset + (i % cols) * (w + gap);
      const y = gap + row * (h + gap);
      ctx.fillStyle = '#1f1f1f';
      ctx.fillRect(x, y, w, h);
      const drawn = !tile.camOff && tile.video && drawCover(ctx, tile.video, x, y, w, h);
      if (!drawn) {
        ctx.fillStyle = '#7f1d1d';
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(Math.min(w, h) / 7)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((tile.name || '?').trim().charAt(0).toUpperCase(), x + w / 2, y + h / 2);
      }
      ctx.font = '600 22px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const label = tile.name || 'Participante';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + 12, y + h - 46, ctx.measureText(label).width + 24, 34);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 24, y + h - 22);
    });
  };

  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  let recorder = null;
  let ticker = null;
  let frames = 0;
  const chunks = [];

  return {
    mimeType,
    async start() {
      await audioCtx.resume(); // AudioContext só arranca depois de um clique (o botão "Gravar")
      syncAudio();
      draw();
      const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...mix.stream.getAudioTracks()]);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000); // pedaços de 1s: uma falha a meio não perde tudo
      ticker = tickerWorker();
      ticker.onmessage = () => {
        draw();
        if (++frames % FPS === 0) syncAudio(); // participantes que entram a meio da gravação
      };
      ticker.postMessage(Math.round(1000 / FPS));
    },

    /** Para e devolve o ficheiro. */
    stop() {
      return new Promise((resolve) => {
        ticker?.postMessage(0);
        ticker?.terminate();
        if (!recorder || recorder.state === 'inactive') return resolve(null);
        recorder.onstop = () => {
          audioCtx.close().catch(() => {});
          resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
        };
        recorder.stop();
      });
    },
  };
}

/** Descarrega o ficheiro gravado no computador de quem gravou. */
export function downloadRecording(blob, title) {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safe = (title || 'reuniao').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe || 'reuniao'}-${stamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
