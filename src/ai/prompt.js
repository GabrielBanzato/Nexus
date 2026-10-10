/**
 * Prompt e formato de resposta do Nex nas SUGESTÕES de resposta do WhatsApp (quem envia é
 * sempre um consultor, que pode editar o rascunho antes).
 *
 * Funciona com o modelo local pequeno (Qwen 3.5 2B, CPU) e com o Claude (AI_PROVIDER=anthropic):
 *  - O modelo recebe a FICHA do cliente (ramo, cidade, se tem site, etapa da negociação, dores...)
 *    e a conversa como transcrição, e responde ao que o cliente disse — não com frases feitas.
 *  - Saída estruturada: classifica, resume o que entendeu e o objetivo da resposta, e SÓ DEPOIS
 *    escreve (esse "raciocínio" curto em campos melhora muito o modelo pequeno).
 *  - System prompt FIXO (nada por cliente lá dentro): o llama.cpp reaproveita a cache do
 *    prefixo entre pedidos e, na CPU, só processa o pedido novo.
 *  - Guardas de saída: negar um serviço que fazemos, repetir uma mensagem já enviada, ou não
 *    falar da nossa IA (o diferencial: vai em todo projeto) → 2.ª tentativa com a correção.
 *
 * Para mudar o que a empresa oferece ou o tom, edite BUSINESS_PROFILE.
 */

export const BUSINESS_PROFILE = {
  name: 'Nexus',
  // Verbos explícitos ("Criamos...", "o cliente vende"): com frases ambíguas ("lojas virtuais
  // para vender 24h") o modelo pequeno entendia que a EMPRESA vende produtos e negava o serviço.
  offer: [
    'Criamos sites para empresas, otimizados para aparecer no Google, com botão de WhatsApp.',
    'Criamos cardápios digitais: o restaurante recebe pedidos direto no WhatsApp, sem comissão de aplicativo.',
    'Criamos lojas virtuais (e-commerce) para o cliente vender os produtos dele pela internet, 24 horas por dia.',
    'Implantamos sistemas de gestão (ERP) com PDV: estoque, caixa, vendas, financeiro e notas fiscais integrados.',
    'Criamos sistemas para empresas de serviço (clínicas, consultórios, escritórios, salões...): agenda, orçamentos e financeiro juntos.',
  ],
  // O diferencial: TODO projeto vem com a IA própria da Nexus. Benefícios em linguagem de cliente.
  ai: {
    pitch: 'Todo projeto da Nexus já vem com a nossa própria IA integrada (feita por nós, ajustada ao negócio do cliente, não uma ferramenta genérica de terceiros).',
    benefits: [
      'atende os clientes no WhatsApp a qualquer hora, inclusive fora do expediente e nos fins de semana',
      'responde dúvidas, faz orçamentos e marca horários sozinha, e passa para a equipe só o que precisa de uma pessoa',
      'reduz custos com equipe (menos gente presa a responder as mesmas perguntas)',
      'clientes mais satisfeitos, porque recebem resposta na hora',
      'deixa a empresa com cara de moderna, à frente da concorrência',
    ],
  },
  // Como os clientes costumam pedir cada serviço (o modelo reconhece o pedido e confirma).
  synonyms: 'site / página na internet; cardápio digital / pedidos online; loja virtual / e-commerce / vender pela internet / loja online; sistema / ERP / controle de estoque / caixa / PDV; agenda / agendamento / orçamentos; IA / inteligência artificial / chatbot / atendimento automático',
};

/** Bloco do prompt sobre a IA própria (partilhado pelas sugestões e pelas reuniões). */
export const AI_DIFFERENTIATOR = `O grande diferencial da ${BUSINESS_PROFILE.name}: ${BUSINESS_PROFILE.ai.pitch} Benefícios da IA para o cliente:
${BUSINESS_PROFILE.ai.benefits.map((b) => `- ${b}`).join('\n')}`;

export const INTENTS = [
  'saudacao', // oi, bom dia, tudo bem
  'duvida_servico', // o que vocês fazem, como funciona
  'preco', // quanto custa, orçamento, valores
  'agendar_reuniao', // quer conversar, marcar horário, ligação
  'suporte', // já é cliente e tem um problema
  'reclamacao', // irritado, insatisfeito, cobrança
  'sem_interesse', // não quero, pare de mandar
  'fora_de_contexto', // assunto sem relação
  'outro',
];

/**
 * Guarda de saída: a resposta nega um serviço ("não fazemos", "não oferecemos"...)? Todos os
 * serviços da lista são oferecidos, e o modelo de 2B ainda erra ~2% das vezes em geral e ~25%
 * no caso "loja de roupas + vender pela internet". O assistente autocorrige (correctionMessages)
 * e, se repetir, não mostra a sugestão.
 */
export const DENIES_SERVICE = /n[ãa]o (oferece|oferecemos|fazemos|faz|trabalhamos|atuamos|desenvolvemos|realizamos|cria|criamos)\b/i;

export const RESPONSE_SCHEMA = {
  type: 'object',
  // Ordem pensada para modelos pequenos: classificar, entender, decidir o passo e SÓ DEPOIS escrever.
  properties: {
    intent: { type: 'string', enum: INTENTS },
    understanding: { type: 'string', description: 'Em uma frase curta: o que o cliente quer ou sente agora, com os detalhes concretos dele.' },
    next_step: { type: 'string', description: 'Em uma frase curta: o objetivo desta resposta (ex.: descobrir como recebe pedidos hoje, marcar a reunião).' },
    reply: { type: 'string', description: 'A mensagem do consultor, pronta para enviar.' },
  },
  required: ['intent', 'understanding', 'next_step', 'reply'],
};

export const SYSTEM_PROMPT = `Você é o Nex, o assistente de vendas da ${BUSINESS_PROFILE.name}, uma empresa de tecnologia que atende negócios locais pelo WhatsApp. Você escreve a PRÓXIMA mensagem de um consultor em uma conversa real; ele revisa e envia com o nome dele.

O que a ${BUSINESS_PROFILE.name} oferece:
${BUSINESS_PROFILE.offer.map((item) => `- ${item}`).join('\n')}

A ${BUSINESS_PROFILE.name} FAZ todos os serviços acima. Quando o cliente pedir qualquer um deles (${BUSINESS_PROFILE.synonyms}), confirme que fazemos. Nunca diga que não fazemos um serviço desta lista.

${AI_DIFFERENTIATOR}

Sempre destaque a nossa IA:
- Sempre que falar do que a ${BUSINESS_PROFILE.name} faz (serviços, como funciona, proposta, preço, por que nos escolher), diga que o projeto já vem com a nossa própria IA e ligue UM benefício dela à dor ou ao ramo do cliente (ex.: clínica → marca consultas sozinha à noite; restaurante → atende os pedidos no pico).
- Se a IA ainda não apareceu na conversa, apresente-a na sua resposta. Se já apareceu, mostre outro benefício, sem repetir a mesma frase.
- Sem exageros nem números inventados: fale dos benefícios acima.

Como um bom vendedor conversa:
- Leia a conversa inteira e responda ao que o cliente disse AGORA, com os detalhes dele (o negócio, a cidade, o que perguntou). Se ele fez uma pergunta, responda-a primeiro.
- Nada de frases genéricas ("Se tiver alguma dúvida, estou à disposição", "Como posso ajudar?"). Cada mensagem tem de fazer a conversa andar.
- Nunca repita, nem com outras palavras, uma mensagem que o consultor já enviou. Não cumprimente de novo se já houve cumprimento.
- Faça UMA pergunta por mensagem, concreta e fácil de responder, para entender o negócio e a dor do cliente (ex.: como recebe os pedidos hoje, se aparece no Google, quanto paga de comissão ao app).
- Use o que se sabe do negócio (ramo, cidade, avaliações, se tem site) para mostrar que conhece o cliente, sem parecer robô.
- Quando o cliente já mostrou interesse, leve a uma conversa rápida (chamada ou reunião) e proponha um horário; antes disso, crie interesse.
- Tom de WhatsApp: curto (1 a 3 frases), natural e caloroso, no mesmo nível de formalidade do cliente. No máximo um emoji, e só se o cliente usar.
- Escreva SEMPRE no idioma do cliente (temos clientes nos EUA, Austrália e América Latina): o idioma em que ele escreve; se ele ainda não escreveu, o do país do negócio.
- Não assine nem se apresente pelo nome: a assinatura é colocada automaticamente.
- Nunca invente preços, prazos, descontos ou promessas. Se perguntarem valores, diga que depende do que o negócio precisa e faça uma pergunta para montar o orçamento (ou proponha uma conversa rápida).
- Suporte ou reclamação: peça desculpas e pergunte os detalhes do problema.
- Sem interesse: agradeça com educação e despeça-se, sem insistir.
- Não fale de assuntos que não tenham relação com a ${BUSINESS_PROFILE.name}.

Responda em JSON com:
- "intent": a intenção da ÚLTIMA mensagem do cliente, uma de: ${INTENTS.join(', ')}.
- "understanding": o que o cliente quer/sente agora (uma frase).
- "next_step": o objetivo da sua resposta (uma frase).
- "reply": a mensagem do consultor.`;

/**
 * Autocorreção para a 2.ª tentativa (a resposta negou um serviço oferecido, ou repetiu uma
 * mensagem já enviada). Medido na negação: só baixar a temperatura NÃO resolve (0/4 — o modelo
 * repete o mesmo erro); mostrar a resposta errada e a correção resolveu 11/11.
 */
export function correctionMessages(wrongReply, problem) {
  return [
    { role: 'assistant', content: JSON.stringify({ reply: wrongReply }) },
    { role: 'user', content: `Correção: essa resposta está ERRADA. ${problem} Escreva outra, seguindo as regras.` },
  ];
}

export const DENIAL_CORRECTION = `A ${BUSINESS_PROFILE.name} cria, ela mesma, lojas virtuais (e-commerce), sites, cardápios digitais e sistemas de gestão. Confirme que fazemos o que o cliente pediu.`;
export const MISSING_AI_CORRECTION = `Ela não fala da nossa IA. Mantenha a resposta ao cliente e inclua, em uma frase natural, que o projeto já vem com a IA própria da ${BUSINESS_PROFILE.name} e UM benefício dela ligado ao negócio dele (ex.: atende os clientes no WhatsApp a qualquer hora, faz orçamentos e marca horários sozinha, reduz custos com equipe).`;

// Menciona IA? "IA"/"AI" só em maiúsculas (em português "ia" também é verbo); o resto sem caixa.
const MENTIONS_AI = /\b(IA|AI|I\.A\.)\b|intelig[eê]ncia artificial|artificial intelligence|inteligencia artificial/;
const MENTIONS_AI_CI = /intelig[eê]ncia artificial|artificial intelligence|inteligencia artificial/i;
const mentionsAi = (text) => MENTIONS_AI.test(String(text ?? '')) || MENTIONS_AI_CI.test(String(text ?? ''));
// Respostas em que vender a IA soa mal: o cliente não quer, ou tem um problema a resolver.
const NO_PITCH_INTENTS = new Set(['sem_interesse', 'suporte', 'reclamacao', 'fora_de_contexto']);
const RECENT_FOR_AI = 4; // mensagens do consultor: se a IA já apareceu nelas, não se insiste

/**
 * A resposta devia falar da nossa IA e não fala? (só quando a IA não apareceu nas últimas
 * mensagens do consultor, para não virar disco riscado)
 */
export function missingAiPitch(reply, intent, history) {
  if (NO_PITCH_INTENTS.has(intent) || mentionsAi(reply)) return false;
  const recent = history.filter((m) => m.sender_type !== 'client').slice(-RECENT_FOR_AI);
  return !recent.some((m) => mentionsAi(m.content));
}

export const REPEAT_CORRECTION ='Ela repete uma mensagem que o consultor já enviou. Responda ao que o cliente disse por último e faça a conversa andar, com outras palavras e outra pergunta.';

const STAGE_LABELS = {
  lead: 'primeiro contato',
  meeting: 'reunião agendada',
  negotiation: 'em negociação',
  awaiting: 'proposta enviada, à espera de resposta',
  won: 'cliente fechado',
  lost: 'negócio perdido',
};
const CLIENT_STATUS_LABELS = { lead: 'lead (ainda não é cliente)', active: 'já é cliente', on_hold: 'em espera', archived: 'arquivado' };
const LANGUAGE_NAMES = { pt: 'português do Brasil', en: 'inglês', es: 'espanhol' };
const MESSAGE_CHARS = 700; // por mensagem no histórico (o pedido não pode crescer sem limite)

function formatDate(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

/**
 * Ficha do cliente para o modelo: o que se sabe do negócio e da negociação. Só linhas com dados.
 * @param {object} ctx { client, lead, deal, consultant, country, now, timeZone }
 * @returns {string}
 */
export function describeContext({ client, lead, deal, consultant, country, now = new Date(), timeZone } = {}) {
  const lines = [];
  const add = (label, value) => {
    const text = value == null ? '' : String(value).trim();
    if (text) lines.push(`- ${label}: ${text}`);
  };
  add('Contato', client?.name);
  add('Empresa', client?.company && client.company !== client.name ? client.company : null);
  add('Ramo', lead?.nicho);
  add('Endereço', lead?.endereco);
  if (country) add('País / idioma provável', `${country.label} (${LANGUAGE_NAMES[country.lang] ?? country.lang})`);
  if (lead) {
    add('Site', lead.website ? `tem (${lead.website})` : 'NÃO tem site');
    if (lead.nota) add('Google', `nota ${lead.nota}${lead.avaliacoes_qtd ? ` com ${lead.avaliacoes_qtd} avaliações` : ''}`);
  }
  add('Situação', CLIENT_STATUS_LABELS[client?.status]);
  if (deal) {
    add('Etapa da negociação', STAGE_LABELS[deal.stage] ?? deal.stage);
    if (deal.meeting_at && new Date(deal.meeting_at) > now) add('Reunião marcada', formatDate(deal.meeting_at, timeZone));
    add('Dores do cliente', deal.pains);
    add('Proposta', deal.final_proposal || deal.proposal_offer);
    add('Gancho do vendedor', deal.bait);
    add('Motivo da perda', deal.stage === 'lost' ? deal.lost_reason : null);
  }
  add('Consultor', consultant);
  add('Agora', formatDate(now, timeZone));
  return lines.join('\n');
}

/**
 * Mensagens para o modelo: system FIXO + UM pedido com a ficha do cliente e a conversa como
 * transcrição ("Cliente:" / "Consultor:"). Em transcrição e não como turnos user/assistant: o
 * modelo pequeno, a "continuar" turnos do assistente, repetia as mensagens do consultor.
 */
export function buildMessages({ context = '', history }) {
  const transcript = history
    .map((m) => {
      const text = String(m.content ?? '').trim().slice(0, MESSAGE_CHARS) || '[mídia]';
      return `${m.sender_type === 'client' ? 'Cliente' : 'Consultor'}: ${text}`;
    })
    .join('\n');
  const last = history.at(-1);
  const task =
    !last || last.sender_type === 'client'
      ? 'Escreva a próxima mensagem do consultor, respondendo à última mensagem do cliente.'
      : 'A última mensagem é do consultor e o cliente ainda não respondeu. Escreva um follow-up curto que retome a conversa por outro ângulo (uma pergunta concreta ou um benefício para o negócio dele), sem repetir nada do que já foi dito.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${context ? `Ficha do cliente:\n${context}\n\n` : ''}Conversa (da mais antiga para a mais recente):\n${transcript || '(ainda sem mensagens)'}\n\n${task}`,
    },
  ];
}

const words = (text) => new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? []);

/** A resposta é (quase) igual a alguma mensagem já enviada pelo consultor? */
export function repeatsPrevious(reply, history) {
  const a = words(reply);
  if (a.size < 3) return false;
  return history
    .filter((m) => m.sender_type !== 'client')
    .some((m) => {
      const b = words(m.content);
      let common = 0;
      for (const w of a) if (b.has(w)) common += 1;
      return common / Math.max(a.size, b.size) >= 0.6;
    });
}
