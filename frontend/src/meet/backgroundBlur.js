import { createGlBlurRenderer } from './blurRenderer.js';
import { tickerWorker } from './recorder.js';

/**
 * Desfoque do fundo da câmara, no navegador de quem o liga (nada passa pelo servidor).
 *
 *  1. Nativo: alguns navegadores/sistemas (ex.: Chrome no Windows/ChromeOS com efeitos de
 *     câmara) têm desfoque próprio (constraint `backgroundBlur`) — sem custo para nós.
 *  2. Senão, MediaPipe (Google) separa a pessoa do fundo e a GPU compõe o resultado
 *     (blurRenderer.js: borda refinada pelas cores da imagem, fundo desfocado SEM a pessoa,
 *     sem halo). Sem WebGL2, uma versão mais simples em canvas 2D.
 *
 * Modelos: no computador o "selfie multiclass" (15,6 MB, distingue cabelo, pele, roupa e
 * acessórios — recorte muito melhor no cabelo e em auscultadores); no telemóvel o leve
 * (0,24 MB). Descarregados só quando alguém liga o desfoque; depois ficam na cache do navegador.
 */

const MEDIAPIPE_VERSION = '0.10.21'; // = package.json (o wasm vem do CDN da mesma versão)
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODELS = {
  // masks[0] = fundo → pessoa = 1 − fundo
  multiclass: { url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite', personIndex: 0, invert: true },
  // masks[0] = pessoa
  light: { url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', personIndex: 0, invert: false },
};
// Resolução da entrada do modelo (16:9). A máscara sai com este tamanho e a GPU refina-a.
const SEG_W = 320;
const SEG_H = 180;
const FPS = 24;
const SMOOTHING = 0.35; // peso do quadro anterior na máscara (tira o tremor da borda)

const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

const segmenters = new Map(); // modelo → Promise do segmentador

function loadSegmenter(modelKey) {
  if (!segmenters.has(modelKey)) {
    const promise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const create = (delegate) =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODELS[modelKey].url, delegate },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
      return create('GPU').catch(() => create('CPU'));
    })();
    promise.catch(() => segmenters.delete(modelKey)); // deixa tentar de novo
    segmenters.set(modelKey, promise);
  }
  return segmenters.get(modelKey);
}

/** O melhor modelo para este aparelho; se não carregar (rede, memória), o leve. */
async function loadBestSegmenter() {
  if (!isMobile()) {
    try {
      return { segmenter: await loadSegmenter('multiclass'), model: MODELS.multiclass };
    } catch (err) {
      console.warn('Desfoque: modelo completo indisponível, a usar o leve', err);
    }
  }
  return { segmenter: await loadSegmenter('light'), model: MODELS.light };
}

/** Desfoque nativo da câmara, se o navegador o oferecer nesta faixa. */
export function nativeBlurSupported(track) {
  const caps = track?.getCapabilities?.();
  return Array.isArray(caps?.backgroundBlur) ? caps.backgroundBlur.includes(true) : Boolean(caps?.backgroundBlur);
}

export async function setNativeBlur(track, on) {
  await track.applyConstraints({ advanced: [{ backgroundBlur: on }] });
}

/** Composição em canvas 2D, para aparelhos sem WebGL2. */
function createCanvasRenderer(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const mask = document.createElement('canvas');
  mask.width = SEG_W;
  mask.height = SEG_H;
  const maskCtx = mask.getContext('2d');
  const maskImage = maskCtx.createImageData(SEG_W, SEG_H);
  const person = document.createElement('canvas');
  person.width = width;
  person.height = height;
  const personCtx = person.getContext('2d');
  const blurPx = Math.round(width / 80);
  return {
    canvas,
    render(video, alpha) {
      for (let i = 0; i < alpha.length; i += 1) maskImage.data[i * 4 + 3] = alpha[i];
      maskCtx.putImageData(maskImage, 0, 0);
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(video, -blurPx * 2, -blurPx * 2, width + blurPx * 4, height + blurPx * 4);
      ctx.filter = 'none';
      personCtx.globalCompositeOperation = 'copy';
      personCtx.drawImage(video, 0, 0, width, height);
      personCtx.globalCompositeOperation = 'destination-in';
      personCtx.filter = 'blur(1.5px)';
      personCtx.drawImage(mask, 0, 0, width, height);
      personCtx.filter = 'none';
      ctx.drawImage(person, 0, 0);
    },
    destroy() {},
  };
}

/**
 * Faixa de vídeo com o fundo desfocado, a partir da faixa da câmara.
 * @returns {Promise<{ track: MediaStreamTrack, stop: () => void, quality: 'gpu'|'canvas', model: string }>}
 */
export async function createBlurredTrack(sourceTrack) {
  const { segmenter, model } = await loadBestSegmenter();
  const settings = sourceTrack.getSettings();
  const width = settings.width || 1280;
  const height = settings.height || 720;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([sourceTrack]);
  await video.play().catch(() => {});

  const seg = document.createElement('canvas'); // entrada do modelo
  seg.width = SEG_W;
  seg.height = SEG_H;
  const segCtx = seg.getContext('2d', { willReadFrequently: true });

  let renderer = null;
  try {
    renderer = createGlBlurRenderer(width, height);
  } catch (err) {
    console.warn('Desfoque: WebGL indisponível, a usar canvas 2D', err);
  }
  const quality = renderer ? 'gpu' : 'canvas';
  renderer ??= createCanvasRenderer(width, height);

  const smooth = new Float32Array(SEG_W * SEG_H); // máscara com suavização entre quadros
  const mask8 = new Uint8Array(SEG_W * SEG_H);
  let first = true;
  let lastTs = -1;

  const frame = () => {
    if (video.readyState < 2 || sourceTrack.readyState !== 'live') return;
    segCtx.drawImage(video, 0, 0, SEG_W, SEG_H);
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    const result = segmenter.segmentForVideo(seg, ts);
    const raw = result.confidenceMasks?.[model.personIndex]?.getAsFloat32Array();
    if (raw && raw.length === smooth.length) {
      const keep = first ? 0 : SMOOTHING;
      for (let i = 0; i < raw.length; i += 1) {
        const p = model.invert ? 1 - raw[i] : raw[i];
        smooth[i] = smooth[i] * keep + p * (1 - keep);
        mask8[i] = smooth[i] * 255;
      }
      first = false;
    }
    result.close();
    if (!first) renderer.render(video, mask8, SEG_W, SEG_H);
  };

  // Relógio num Worker: com a aba em segundo plano o vídeo enviado não congela.
  const ticker = tickerWorker();
  ticker.onmessage = () => {
    try {
      frame();
    } catch (err) {
      console.warn('Desfoque: quadro ignorado', err);
    }
  };
  ticker.postMessage(Math.round(1000 / FPS));

  const track = renderer.canvas.captureStream(FPS).getVideoTracks()[0];
  return {
    track,
    quality,
    model: model === MODELS.multiclass ? 'multiclass' : 'light',
    stop() {
      ticker.postMessage(0);
      ticker.terminate();
      track.stop();
      renderer.destroy();
      video.srcObject = null;
    },
  };
}
