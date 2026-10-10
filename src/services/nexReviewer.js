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

const systemPrompt = (lang) => `Você é o Nex, o revisor de mensagens de WhatsApp da Nexus (empresa de sites e sistemas).
Um consultor escreveu uma mensagem para um cliente. A mensagem está em ${LANGUAGES[lang]}: as duas versões que você devolve têm de estar em ${LANGUAGES[lang]}. Nunca traduza para outro idioma.

1. "corrected": a MESMA mensagem, só com a ortografia, os acentos, a pontuação, as maiúsculas e a gramática corrigidos. Não troque palavras certas, não mude o tom, não acrescente nem tire informação. Se já estiver certa, devolva-a igual.
2. "rewrite": a mensagem reformulada para ficar mais clara, simpática e profissional, como um bom vendedor escreveria no WhatsApp. Mesmo sentido, mesmas informações (valores, datas, horários, links, nomes) e o mesmo pedido ou pergunta final. Tamanho parecido. Sem saudações nem despedidas novas que não estejam no original.

Regras para as duas:
- Mantenha a formatação do WhatsApp (*negrito*, _itálico_), os emojis e os links.
- Devolva um único parágrafo em cada campo (sem linhas em branco).
- Nunca invente links, valores ou informações e nunca use marcadores como [link] ou [nome].
- Não assine a mensagem nem fale de si mesmo.
- Responda apenas com o JSON pedido.`;

// Mensagens com vários parágrafos (o modelo pequeno, com o texto inteiro, juntava os parágrafos —
// "Tudo bem?Encontrei..." — ou escrevia "\n\n" literal; com uma lista de parágrafos ou com a
// mensagem toda como contexto, misturava tudo):
//  - correção: PARÁGRAFO A PARÁGRAFO (pedido curto, que ele faz bem) e remontada com as linhas
//    em branco; frases repetidas entre leads (o fecho, por exemplo) vêm da cache;
//  - sugestão: a mensagem inteira (fica coerente) e repartida pelos mesmos parágrafos.
const splitParagraphs = (text) => text.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
/** "\\n" escrito como texto vira quebra de linha; um campo = um parágrafo (o resto é lixo). */
const oneParagraph = (value) => String(value ?? '').replace(/\\r?\\n/g, '\n').split(/\n[ \t]*\n/)[0].trim();

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Negrito/itálico/riscado do WhatsApp como no original. O modelo pequeno mexia nas marcas
 * ("*Vi a America Confeccoes no Google..." com o "*" fora do sítio e sem fecho), o que estraga a
 * formatação. Tira todas as marcas da resposta e volta a pô-las à volta dos MESMOS trechos que
 * estavam marcados no original (se o trecho ainda existir; senão fica sem marca).
 */
export function keepFormatting(original, output) {
  let result = output;
  for (const mark of ['*', '_', '~']) {
    const m = escapeRegExp(mark);
    // Só conta como formatação a marca na borda de uma palavra (o "_" de "a_b_c" num link não).
    const spans = [...original.matchAll(new RegExp(`(?:^|[\\s(])${m}([^${m}\\n]+?)${m}(?=[\\s.,!?;:)]|$)`, 'g'))].map((x) => x[1].trim()).filter(Boolean);
    // Só marcas de formatação (ex.: "_" dentro de um link fica): remove as que estão coladas a palavras.
    result = result.replace(new RegExp(`(^|[\\s(])${m}+|${m}+(?=[\\s.,!?;:)]|$)`, 'g'), '$1');
    for (const span of spans) {
      result = result.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(span)})(?![\\p{L}\\p{N}])`, 'u'), `$1${mark}$2${mark}`);
    }
  }
  return result.trim();
}

/** Marcadores inventados ("[Link Aqui]", "[nome]") que o original não tem: a sugestão não serve. */
const hasPlaceholder = (original, output) => /\[[^\]\n]{1,40}\]/.test(output) && !/\[[^\]\n]{1,40}\]/.test(original);

/**
 * A sugestão da mensagem inteira volta como um bloco só: reparte-a pelo mesmo número de
 * parágrafos do original, frase a frase, na proporção do tamanho de cada parágrafo original.
 */
export function toParagraphs(rewrite, originalParagraphs) {
  const blocks = rewrite.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks.join('\n\n');
  // Fim de frase = pontuação seguida de espaço ("4.6" e "R$ 4.500" não partem a frase).
  const sentences = rewrite.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?…]["')\]]?)\s+/).map((s) => s.trim()).filter(Boolean);
  const n = originalParagraphs.length;
  if (sentences.length <= 1 || n <= 1) return rewrite.trim();
  const total = originalParagraphs.reduce((sum, p) => sum + p.length, 0);
  const totalNew = sentences.reduce((sum, s) => sum + s.length, 0);
  // Fronteiras acumuladas do original (ex.: 10%, 45%, 90%) aplicadas ao texto novo.
  let acc = 0;
  const bounds = originalParagraphs.slice(0, -1).map((p) => (acc += p.length) / total);
  const out = Array.from({ length: n }, () => []);
  let used = 0;
  sentences.forEach((s, i) => {
    const mid = (used + s.length / 2) / totalNew;
    let k = bounds.findIndex((b) => mid <= b);
    if (k === -1) k = n - 1;
    // Nunca deixa um parágrafo vazio a meio: cada um recebe pelo menos uma frase, se houver.
    const remaining = sentences.length - i;
    const emptyAfter = out.slice(k + 1).filter((g) => !g.length).length;
    if (remaining <= emptyAfter) k = out.findIndex((g, idx) => idx > k - 1 && !g.length);
    out[k].push(s);
    used += s.length;
  });
  return out.filter((g) => g.length).map((g) => g.join(' ')).join('\n\n');
}

const CACHE_SIZE = 600;
const LONG_TEXT = 450; // acima disto: só a correção (sem reformular a mensagem inteira)
const MIN_STEP_MS = 12_000; // tempo mínimo para ainda tentar corrigir mais um parágrafo
const REWRITE_MIN_MS = 25_000; // e para ainda tentar a reformulação

/** Tokens para as duas versões: ~1 token a cada 3 caracteres, cada versão do tamanho do original. */
const budget = (text) => Math.min(Math.ceil(text.length / 3) * 2 + 140, 2400);

export function createNexReviewer({ ollama, logger }) {
  const cache = new Map(); // idioma + parágrafo → resultado (o mesmo texto não é revisto duas vezes)
  const inflight = new Map(); // pedidos iguais em simultâneo partilham a mesma geração

  /**
   * Um pedido ao modelo. `fields`: quais versões pedir ('corrected', 'rewrite' ou as duas).
   * Se o JSON vier cortado (o modelo entra em repetição até esgotar os tokens), tenta uma vez
   * mais "frio" e com mais folga.
   */
  async function ask(text, lang, fields) {
    const schema = {
      type: 'object',
      properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])),
      required: fields,
    };
    const call = (temperature, maxTokens) =>
      ollama.chat({
        messages: [
          { role: 'system', content: systemPrompt(lang) },
          { role: 'user', content: `Mensagem (${LANGUAGES[lang]}):\n${text}` },
        ],
        format: schema,
        temperature,
        maxTokens,
      });
    const tokens = Math.round(budget(text) * (fields.length === 2 ? 1 : 0.6));
    try {
      return (await call(0.2, tokens)).data;
    } catch (err) {
      logger.warn({ err: err.message }, 'Nex: resposta inválida, a tentar de novo');
      return (await call(0, Math.round(tokens * 1.5))).data;
    }
  }

  /** Com cache (idioma + texto + o que se pediu) e partilha de pedidos iguais em simultâneo. */
  function cached(kind, text, lang, run) {
    const key = createHash('sha256').update(`${kind}\n${lang}\n${text}`).digest('hex');
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const job = run()
      .then((result) => {
        cache.set(key, result);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
        return result;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  /** Sugestão aceitável? (sem marcadores inventados e no mesmo idioma) */
  function usableRewrite(original, rewrite, lang) {
    if (!rewrite) return false;
    if (hasPlaceholder(original, rewrite)) {
      logger.warn({ rewrite: rewrite.slice(0, 80) }, 'Nex: sugestão com marcador inventado descartada');
      return false;
    }
    if (original.length >= 25 && detectLanguage(rewrite) !== lang) {
      logger.warn({ lang, rewrite: rewrite.slice(0, 80) }, 'Nex: reformulação noutro idioma descartada');
      return false;
    }
    return true;
  }

  return {
    /**
     * `deadline` (ms): se o tempo estiver a acabar (fila do modelo ocupada, texto longo), entrega o
     * que já tem — os parágrafos que faltam ficam como estão e a reformulação é saltada — em vez
     * de falhar tudo. Texto longo (> LONG_TEXT) só leva a correção: a reformulação da mensagem
     * inteira era o passo mais caro e quase nunca é usada numa mensagem longa já pensada.
     * @returns {Promise<{ language: string, corrected: string, rewrite: string, ms: number, partial: boolean }>}
     */
    async review(text, { deadline = Infinity } = {}) {
      const lang = detectLanguage(text); // pelo texto todo: um parágrafo curto engana a deteção
      const paragraphs = splitParagraphs(text);
      const started = Date.now();
      const timeLeft = () => deadline - Date.now();
      let corrected;
      let rewrite;
      let partial = false;

      if (paragraphs.length === 1) {
        // Caso comum no chat: um pedido só, com as duas versões.
        const data = await cached('both', text, lang, () => ask(text, lang, ['corrected', 'rewrite']));
        corrected = keepFormatting(text, oneParagraph(data.corrected)) || text;
        rewrite = keepFormatting(text, oneParagraph(data.rewrite));
      } else {
        // Correção parágrafo a parágrafo (em série: o Ollama do VPS gera uma de cada vez)...
        const fixed = [];
        for (const p of paragraphs) {
          if (timeLeft() < MIN_STEP_MS) {
            partial = true;
            fixed.push(p);
            continue;
          }
          const data = await cached('corrected', p, lang, () => ask(p, lang, ['corrected']));
          fixed.push(keepFormatting(p, oneParagraph(data.corrected)) || p);
        }
        corrected = fixed.join('\n\n');
        // ...e a sugestão da mensagem inteira (coerente), redistribuída pelos mesmos parágrafos.
        if (text.length <= LONG_TEXT && timeLeft() >= REWRITE_MIN_MS) {
          const data = await cached('rewrite', text, lang, () => ask(text, lang, ['rewrite']));
          rewrite = keepFormatting(text, toParagraphs(String(data.rewrite ?? '').replace(/\\r?\\n/g, '\n'), paragraphs));
        } else {
          if (text.length <= LONG_TEXT) partial = true;
          rewrite = corrected;
        }
      }
      if (!usableRewrite(text, rewrite, lang)) rewrite = corrected;

      const result = { language: lang, corrected, rewrite, ms: Date.now() - started, partial };
      logger.info({ chars: text.length, paragraphs: paragraphs.length, lang, ms: result.ms, partial }, 'Nex: mensagem revista');
      return result;
    },
  };
}
