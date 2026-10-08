import { createHash } from 'node:crypto';

/**
 * Nex: a IA da casa (o mesmo Qwen do Ollama) a rever cada mensagem antes de sair pela Central.
 * Devolve sempre duas propostas, no MESMO idioma do texto:
 *  - corrected: o texto do consultor só com ortografia, acentos, pontuação e gramática corrigidos;
 *  - rewrite:   uma reformulação mais clara e profissional, com o mesmo sentido.
 * O consultor escolhe (ou envia o seu); nada é enviado sozinho.
 */

const LANGUAGES = { pt: 'português do Brasil', en: 'inglês (English)', es: 'espanhol (español)' };

// Palavras curtas muito frequentes de cada idioma: chega para dizer ao modelo em que língua
// responder (sem isto o Qwen pequeno às vezes "reformulava" um texto em espanhol para português).
const STOPWORDS = {
  pt: 'que não nao você voce vocês voces tem têm uma um para com seu sua isso está esta muito obrigado olá ola oi bom dia tudo bem posso amanhã amanha fica é e o os as da do das dos no na em me te vi',
  en: 'the and you your is are have has not dont don\'t can i we our to for with this that it hi hello thanks tomorrow website would could will my of a an on',
  es: 'que el la los las usted ustedes su sus tiene tienen no es una un para con por pero muy gracias hola buenos mañana puedo le les del al vi negocio página pagina',
};
const SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));

/** 'pt' | 'en' | 'es' pelo maior número de palavras comuns (empate/sem sinal = português). */
export function detectLanguage(text) {
  const words = text.toLowerCase().match(/[a-zà-ÿñ']+/g) ?? [];
  const score = { pt: 0, en: 0, es: 0 };
  for (const w of words) for (const lang of Object.keys(score)) if (SETS[lang].has(w)) score[lang] += 1;
  // Sinais próprios de cada língua valem mais.
  if (/[ñ¿¡]/.test(text)) score.es += 3;
  if (/[ãõç]/.test(text)) score.pt += 3;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > score.pt ? best[0] : 'pt';
}

const systemPrompt = (lang) => `Você é o Nex, o revisor de mensagens de WhatsApp da Encoding (empresa de sites e sistemas).
Um consultor escreveu uma mensagem para um cliente. A mensagem está em ${LANGUAGES[lang]}: as duas versões que você devolve têm de estar em ${LANGUAGES[lang]}. Nunca traduza para outro idioma.

1. "corrected": a MESMA mensagem, só com a ortografia, os acentos, a pontuação, as maiúsculas e a gramática corrigidos. Não troque palavras certas, não mude o tom, não acrescente nem tire informação. Se já estiver certa, devolva-a igual.
2. "rewrite": a mensagem reformulada para ficar mais clara, simpática e profissional, como um bom vendedor escreveria no WhatsApp. Mesmo sentido, mesmas informações (valores, datas, horários, links, nomes) e o mesmo pedido ou pergunta final. Tamanho parecido. Sem saudações nem despedidas novas que não estejam no original.

Regras para as duas:
- Mantenha a formatação do WhatsApp (*negrito*, _itálico_), os emojis, os links e as quebras de linha.
- Não assine a mensagem nem fale de si mesmo.
- Responda apenas com o JSON pedido.`;

const SCHEMA = {
  type: 'object',
  properties: { language: { type: 'string' }, corrected: { type: 'string' }, rewrite: { type: 'string' } },
  required: ['language', 'corrected', 'rewrite'],
};

/**
 * O modelo pequeno às vezes deixa um "*" ou "_" solto (ex.: "*O valor fica..."), que no WhatsApp
 * estraga o negrito/itálico. Marcas que o original não tem saem; as dele ficam.
 */
function keepFormatting(original, output) {
  let result = output;
  for (const mark of ['*', '_', '~']) {
    const count = (s) => s.split(mark).length - 1;
    if (count(result) > count(original) && count(original) === 0) result = result.split(mark).join('');
  }
  return result.trim();
}

const CACHE_SIZE = 300;

/** Tokens para as duas versões: ~1 token a cada 3 caracteres, cada versão do tamanho do original. */
const budget = (text) => Math.min(Math.ceil(text.length / 3) * 2 + 140, 2400);

export function createNexReviewer({ ollama, logger }) {
  const cache = new Map(); // hash do texto → resultado (o mesmo texto não é revisto duas vezes)
  const inflight = new Map(); // pedidos iguais em simultâneo partilham a mesma geração

  async function generate(text) {
    const lang = detectLanguage(text);
    const { data, stats } = await ollama.chat({
      messages: [
        { role: 'system', content: systemPrompt(lang) },
        { role: 'user', content: `Mensagem (${LANGUAGES[lang]}):\n${text}` },
      ],
      format: SCHEMA,
      temperature: 0.2,
      maxTokens: budget(text),
    });
    const corrected = keepFormatting(text, String(data.corrected ?? '').trim()) || text;
    let rewrite = keepFormatting(text, String(data.rewrite ?? '').trim()) || corrected;
    // Se mesmo assim a reformulação vier noutra língua, não a mostra (a correção basta).
    if (text.length >= 25 && detectLanguage(rewrite) !== lang) {
      logger.warn({ lang, rewrite: rewrite.slice(0, 80) }, 'Nex: reformulação noutro idioma descartada');
      rewrite = corrected;
    }
    logger.info({ chars: text.length, lang, ...stats }, 'Nex: mensagem revista');
    return { language: lang, corrected, rewrite, ms: stats.ms };
  }

  return {
    /** @returns {Promise<{ language: string, corrected: string, rewrite: string, ms: number }>} */
    async review(text) {
      const key = createHash('sha256').update(text).digest('hex');
      if (cache.has(key)) return cache.get(key);
      if (inflight.has(key)) return inflight.get(key);
      const job = generate(text)
        .then((result) => {
          cache.set(key, result);
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
          return result;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, job);
      return job;
    },
  };
}
