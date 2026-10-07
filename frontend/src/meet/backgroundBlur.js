import { tickerWorker } from './recorder.js';

/**
 * Desfoque do fundo da câmara, no navegador de quem o liga (nada passa pelo servidor).
 *
 *  1. Nativo: alguns navegadores/sistemas (ex.: Chrome no Windows/ChromeOS com efeitos de
 *     câmara) têm desfoque próprio (constraint `backgroundBlur`) — sem custo de CPU para nós.
 *  2. Senão, MediaPipe (Google): um modelo pequeno (~250 KB) separa a pessoa do fundo em cada
 *     quadro; o canvas desenha o fundo desfocado e a pessoa nítida por cima, e a faixa do canvas
 *     é a que segue na chamada (replaceTrack). A segmentação corre numa imagem pequena
 *     (256×144): leve o bastante para portáteis comuns; a máscara é ampliada com suavização.
 *
 * O MediaPipe só é descarregado quando alguém liga o desfoque pela primeira vez.
 */

const MEDIAPIPE_VERSION = '0.10.21'; // = package.json (o wasm vem do CDN da mesma versão)
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const MASK_W = 256;
const MASK_H = 144;
const FPS = 24;
const BLUR_PX = 14;

let segmenterPromise = null;

/** Um só segmentador por página (carregar o modelo leva 1–3 s na 1.ª vez). */
function loadSegmenter() {
  segmenterPromise ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const create = (delegate) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    // GPU quando há WebGL2; senão CPU (mais lento, mas funciona).
    return create('GPU').catch(() => create('CPU'));
  })().catch((err) => {
    segmenterPromise = null; // deixa tentar de novo
    throw err;
  });
  return segmenterPromise;
}

/** Desfoque nativo da câmara, se o navegador o oferecer nesta faixa. */
export function nativeBlurSupported(track) {
  const caps = track?.getCapabilities?.();
  return Array.isArray(caps?.backgroundBlur) ? caps.backgroundBlur.includes(true) : Boolean(caps?.backgroundBlur);
}

export async function setNativeBlur(track, on) {
  await track.applyConstraints({ advanced: [{ backgroundBlur: on }] });
}

/**
 * Faixa de vídeo com o fundo desfocado, a partir da faixa da câmara.
 * @returns {Promise<{ track: MediaStreamTrack, stop: () => void }>}
 */
export async function createBlurredTrack(sourceTrack) {
  const segmenter = await loadSegmenter();
  const settings = sourceTrack.getSettings();
  const width = settings.width || 1280;
  const height = settings.height || 720;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([sourceTrack]);
  await video.play().catch(() => {});

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');

  const small = document.createElement('canvas'); // entrada da segmentação
  small.width = MASK_W;
  small.height = MASK_H;
  const smallCtx = small.getContext('2d', { willReadFrequently: true });

  const mask = document.createElement('canvas'); // máscara (alfa = "é pessoa")
  mask.width = MASK_W;
  mask.height = MASK_H;
  const maskCtx = mask.getContext('2d');
  const maskImage = maskCtx.createImageData(MASK_W, MASK_H);

  const person = document.createElement('canvas'); // pessoa recortada, em tamanho real
  person.width = width;
  person.height = height;
  const personCtx = person.getContext('2d');

  let lastTs = -1;
  const draw = () => {
    if (video.readyState < 2 || sourceTrack.readyState !== 'live') return;
    // Câmara desligada (enabled=false) chega preta: passa direto, sem gastar com segmentação.
    smallCtx.drawImage(video, 0, 0, MASK_W, MASK_H);
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    const result = segmenter.segmentForVideo(small, ts);
    const confidence = result.confidenceMasks?.[0]?.getAsFloat32Array();
    if (confidence) {
      const data = maskImage.data;
      for (let i = 0; i < confidence.length; i += 1) {
        // Curva suave: bordas sem "halo" duro; fundo com alguma certeza vira transparente.
        const c = confidence[i];
        data[i * 4 + 3] = c < 0.25 ? 0 : c > 0.75 ? 255 : ((c - 0.25) / 0.5) * 255;
      }
      maskCtx.putImageData(maskImage, 0, 0);
    }
    result.close();

    // Fundo desfocado (um pouco ampliado: o blur escurece as bordas do quadro).
    ctx.filter = `blur(${BLUR_PX}px)`;
    ctx.drawImage(video, -BLUR_PX * 2, -BLUR_PX * 2, width + BLUR_PX * 4, height + BLUR_PX * 4);
    ctx.filter = 'none';
    // Pessoa nítida: o vídeo recortado pela máscara (ampliada com suavização = borda macia).
    personCtx.globalCompositeOperation = 'copy';
    personCtx.drawImage(video, 0, 0, width, height);
    personCtx.globalCompositeOperation = 'destination-in';
    personCtx.imageSmoothingEnabled = true;
    personCtx.drawImage(mask, 0, 0, width, height);
    ctx.drawImage(person, 0, 0);
  };

  // Relógio num Worker: com a aba em segundo plano (ex.: a partilhar outra janela) o vídeo
  // enviado não congela.
  const ticker = tickerWorker();
  ticker.onmessage = () => {
    try {
      draw();
    } catch (err) {
      console.warn('Desfoque: quadro ignorado', err);
    }
  };
  ticker.postMessage(Math.round(1000 / FPS));

  const track = out.captureStream(FPS).getVideoTracks()[0];
  return {
    track,
    stop() {
      ticker.postMessage(0);
      ticker.terminate();
      track.stop();
      video.srcObject = null;
    },
  };
}
