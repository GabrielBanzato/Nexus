import { AppError } from '../lib/errors.js';

const MAX_LENGTH = 4096; // = limite do campo de mensagem na Central
const REVIEW_TIMEOUT_MS = 75_000; // limite duro
const REVIEW_DEADLINE_MS = 55_000; // a partir daqui o Nex entrega o que já tem (revisão parcial)

const reviewSchema = {
  body: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: { text: { type: 'string', minLength: 1, maxLength: MAX_LENGTH } },
  },
};

/** Nex (IA da casa): revisão de cada mensagem antes do envio — correção e reformulação. */
export default async function nexRoutes(app) {
  app.post('/api/nex/review', { schema: reviewSchema, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    if (!app.nex) throw new AppError(503, 'NEX_DISABLED', 'O Nex está desligado neste servidor (a IA não está ativa).');
    const text = request.body.text.trim();
    if (!text) throw new AppError(400, 'BAD_REQUEST', 'Mensagem vazia.');
    let timer;
    try {
      const result = await Promise.race([
        app.nex.review(text, { deadline: Date.now() + REVIEW_DEADLINE_MS }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), REVIEW_TIMEOUT_MS);
        }),
      ]);
      return { data: { text, ...result } };
    } catch (err) {
      request.log.warn({ err: err.message }, 'Nex: revisão falhou');
      throw new AppError(503, 'NEX_UNAVAILABLE', err.message === 'timeout' ? 'O Nex demorou demais a responder.' : 'O Nex não conseguiu rever a mensagem agora.');
    } finally {
      clearTimeout(timer);
    }
  });
}
