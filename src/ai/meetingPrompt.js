/**
 * Prompts do Nex nas REUNIÕES: lê a transcrição (Whisper) e ajuda o vendedor a fechar.
 *
 *  - Análise contínua: a cada trecho novo, o modelo devolve só os pontos NOVOS (dores, objeções,
 *    sinais de compra) e uma dica para o vendedor agora. Só os novos, e não a lista toda
 *    reescrita: o modelo pequeno, a reescrever, perdia pontos antigos. A junção e a remoção de
 *    repetidos ficam no código (mergeInsights).
 *  - Dúvidas do cliente: tiradas do texto (frases dele que terminam em "?", o Whisper pontua),
 *    não do modelo — medido: o 2B inventava perguntas que ninguém fez.
 *  - Proposta (a pedido): com os pontos juntados, um rascunho de proposta e argumentos.
 */
import { AI_DIFFERENTIATOR, BUSINESS_PROFILE } from './prompt.js';

export const INSIGHT_KEYS = ['pains', 'questions', 'objections', 'signals'];
export const MAX_PER_KEY = 8;

const item = { type: 'string', description: 'Frase curta (até 12 palavras), com os detalhes concretos que o cliente disse.' };
export const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    pains: { type: 'array', items: item, description: 'Problemas/dores NOVOS do negócio do cliente.' },
    objections: { type: 'array', items: item, description: 'Objeções, preocupações e medos NOVOS (preço, tempo, confiança, sócio...).' },
    signals: { type: 'array', items: item, description: 'Sinais de compra NOVOS: orçamento, prazo, quem decide, urgência, interesse claro.' },
    tip: { type: 'string', description: 'O que o vendedor deve dizer ou perguntar AGORA para avançar (1–2 frases). Vazio se ainda é cedo.' },
  },
  required: ['pains', 'objections', 'signals', 'tip'],
};

const LANG = { pt: 'português do Brasil', en: 'inglês', es: 'espanhol' };

// O que vendemos + o diferencial (a IA própria em todo projeto), igual nas sugestões do WhatsApp.
const offer = `${BUSINESS_PROFILE.offer.map((o) => `- ${o}`).join('\n')}\n\n${AI_DIFFERENTIATOR}`;

export const INSIGHTS_SYSTEM = `Você é o Nex, assistente de vendas da ${BUSINESS_PROFILE.name}. Você acompanha uma reunião de vendas pela transcrição automática (pode ter erros de reconhecimento) e anota o que importa para o vendedor fechar o negócio.

O que a ${BUSINESS_PROFILE.name} vende:
${offer}

Regras:
- A transcrição marca quem fala: "Vendedor" e "Cliente". Anote SÓ o que o Cliente disse ou deixou claro, com os detalhes concretos dele (números, nomes de apps, pessoas, datas). Perguntas do Vendedor nunca entram.
- Dores: problemas do negócio dele (custos, perdas, falta de tempo, atendimento...).
- Objeções: medos, receios e "mas..." do Cliente (preço, risco, confiança, precisar de outra pessoa para decidir).
- Sinais de compra: o Cliente mostra que quer avançar (prazo desejado, "gostei", quem decide, quando quer começar).
- Devolva apenas pontos NOVOS: o que já está em "Já anotado" não volta a aparecer, nem com outras palavras.
- Nada inventado: se o trecho não traz nada novo em uma categoria, devolva a lista vazia.
- Frases curtas, em português do Brasil, como anotações para bater o olho durante a conversa.
- "tip": a melhor próxima fala ou pergunta do vendedor agora, para responder a uma dúvida, tratar uma objeção ou avançar para o fechamento. Sempre que encaixar, use um benefício da nossa IA ligado a uma dor que o cliente disse (ex.: "perde cliente fora do horário" → a IA atende a qualquer hora). Sem números nem preços inventados.`;

const list = (title, values) => (values?.length ? `${title}:\n${values.map((v) => `- ${v}`).join('\n')}` : `${title}: (nada)`);

export function insightsMessages({ context, insights, transcript }) {
  const known = [
    list('Dores', insights?.pains),
    list('Objeções', insights?.objections),
    list('Sinais de compra', insights?.signals),
  ].join('\n');
  return [
    { role: 'system', content: INSIGHTS_SYSTEM },
    {
      role: 'user',
      content: `${context ? `Ficha do cliente:\n${context}\n\n` : ''}Já anotado:\n${known}\n\nTrecho novo da reunião:\n${transcript}\n\nAnote os pontos novos e a dica.`,
    },
  ];
}

export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Em 1–2 frases: a situação do cliente e o que ele precisa.' },
    proposal: { type: 'string', description: 'A proposta: o que a Nexus vai fazer para resolver as dores dele (2–4 frases, sem preço).' },
    arguments: { type: 'array', items: { type: 'string' }, description: 'Até 4 argumentos, cada um ligado a uma dor ou objeção que ele disse.' },
    closing: { type: 'string', description: 'A frase para pedir o fechamento ou o próximo passo concreto.' },
  },
  required: ['summary', 'proposal', 'arguments', 'closing'],
};

export function proposalMessages({ context, insights, transcript, lang = 'pt' }) {
  return [
    {
      role: 'system',
      content: `Você é o Nex, assistente de vendas da ${BUSINESS_PROFILE.name}. Com o que se ouviu na reunião, monte uma proposta para o vendedor apresentar AGORA.

O que a ${BUSINESS_PROFILE.name} vende:
${offer}

Regras:
- A proposta resolve as dores que o cliente disse e responde às objeções dele, com os detalhes concretos.
- Proponha só o(s) serviço(s) da lista acima que resolvem as dores dele (normalmente 1 ou 2), não a lista toda.
- A proposta SEMPRE destaca que o projeto já vem com a nossa própria IA, com os benefícios dela ligados às dores do cliente; pelo menos um argumento é sobre a IA.
- Nunca invente preços, valores, estimativas, descontos ou prazos que não foram ditos. Não faça contas.
- Argumentos são afirmações curtas (não perguntas), cada um ligado a uma dor ou objeção.
- Escreva em ${LANG[lang] ?? LANG.pt} (o idioma do cliente), em tom de conversa, pronto para o vendedor falar ou enviar.`,
    },
    {
      role: 'user',
      content: `${context ? `Ficha do cliente:\n${context}\n\n` : ''}${[list('Dores', insights?.pains), list('Dúvidas', insights?.questions), list('Objeções', insights?.objections), list('Sinais de compra', insights?.signals)].join('\n')}\n\nFinal da conversa:\n${transcript}`,
    },
  ];
}

const words = (text) => new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) ?? []);
const similar = (a, b) => {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / Math.min(x.size, y.size) >= 0.7;
};

/**
 * Junta os pontos novos aos anotados: sem repetidos (mesmas palavras), frases cortadas,
 * no máximo MAX_PER_KEY por categoria (ficam os mais recentes). A dica é sempre a última.
 */
export function mergeInsights(current, found) {
  const next = { ...(current ?? {}) };
  for (const key of INSIGHT_KEYS) {
    const list = [...(current?.[key] ?? [])];
    for (const raw of Array.isArray(found?.[key]) ? found[key] : []) {
      const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (text.length < 4 || list.some((old) => similar(old, text))) continue;
      list.push(text);
    }
    next[key] = list.slice(-MAX_PER_KEY);
  }
  const tip = String(found?.tip ?? '').trim();
  if (tip) next.tip = tip.slice(0, 400);
  return next;
}

/**
 * Dúvidas do cliente num trecho: as frases DELE que terminam em "?" (o Whisper pontua).
 * @param {Array<{ role: 'staff'|'guest', text: string }>} segments
 */
export function clientQuestions(segments) {
  const out = [];
  for (const seg of segments) {
    if (seg.role !== 'guest') continue;
    for (const sentence of String(seg.text).match(/[^.!?]*\?/g) ?? []) {
      const q = sentence.replace(/^[\s,;:-]+/, '').replace(/^(e|mas|então|tá|ok|olha|entendi)[,\s]+/i, '').trim();
      if (q.split(/\s+/).length >= 3) out.push(q.charAt(0).toUpperCase() + q.slice(1));
    }
  }
  return out;
}
