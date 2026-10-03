/**
 * Prompt e formato de resposta do agente de IA do WhatsApp.
 *
 * Desenhado para um modelo pequeno (Qwen 3.5 2B, CPU):
 *  - O modelo só CLASSIFICA a intenção e ESCREVE a resposta. A decisão de passar a conversa
 *    para um humano é do código (HANDOFF_INTENTS), não do modelo: regra de negócio não fica
 *    à mercê de um 2B.
 *  - Saída com JSON Schema (structured outputs do Ollama): a geração é restrita à gramática
 *    do schema, por isso o JSON vem sempre válido.
 *  - System prompt FIXO (nada por cliente lá dentro): o llama.cpp reaproveita a cache do
 *    prefixo entre pedidos e, na CPU, só processa as mensagens novas.
 *
 * Para mudar o que a empresa oferece ou o tom, edite BUSINESS_PROFILE.
 */

export const BUSINESS_PROFILE = {
  name: 'Encoding',
  // Verbos explícitos ("Criamos...", "o cliente vende"): com frases ambíguas ("lojas virtuais
  // para vender 24h") o modelo pequeno entendia que a EMPRESA vende produtos e negava o serviço.
  offer: [
    'Criamos sites para empresas, otimizados para aparecer no Google, com botão de WhatsApp.',
    'Criamos cardápios digitais: o restaurante recebe pedidos direto no WhatsApp, sem comissão de aplicativo.',
    'Criamos lojas virtuais (e-commerce) para o cliente vender os produtos dele pela internet, 24 horas por dia.',
    'Implantamos sistemas de gestão (ERP) com PDV: estoque, caixa, vendas, financeiro e notas fiscais integrados.',
  ],
  // Como os clientes costumam pedir cada serviço (o modelo reconhece o pedido e confirma).
  synonyms: 'site / página na internet; cardápio digital / pedidos online; loja virtual / e-commerce / vender pela internet / loja online; sistema / ERP / controle de estoque / caixa / PDV',
};

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
 * Intenções que passam SEMPRE para um humano (o bot responde uma vez, avisa e fica calado).
 * Preço e reunião: é o momento de venda, o vendedor assume. Suporte/reclamação: humano sempre.
 */
export const HANDOFF_INTENTS = new Set(['preco', 'agendar_reuniao', 'suporte', 'reclamacao']);

/**
 * Guarda de saída: a resposta nega um serviço ("não fazemos", "não oferecemos"...)? Todos os
 * serviços da lista são oferecidos, e o modelo de 2B ainda erra ~2% das vezes em geral (1/48 com
 * este prompt; 4/48 com o anterior) e ~25% no caso "loja de roupas + vender pela internet".
 * O agente autocorrige (correctionMessages) e, se repetir, não envia (passa a humano).
 */
export const DENIES_SERVICE = /n[ãa]o (oferece|oferecemos|fazemos|faz|trabalhamos|atuamos|desenvolvemos|realizamos|cria|criamos)\b/i;

export const RESPONSE_SCHEMA = {
  type: 'object',
  // Ordem pensada para modelos pequenos: classificar primeiro, escrever depois.
  properties: {
    intent: { type: 'string', enum: INTENTS },
    reply: { type: 'string' },
  },
  required: ['intent', 'reply'],
};

export const SYSTEM_PROMPT = `Você é o assistente virtual da ${BUSINESS_PROFILE.name}, uma empresa de tecnologia que atende negócios locais pelo WhatsApp.

O que a ${BUSINESS_PROFILE.name} oferece:
${BUSINESS_PROFILE.offer.map((item) => `- ${item}`).join('\n')}

A ${BUSINESS_PROFILE.name} FAZ todos os serviços acima. Quando o cliente pedir qualquer um deles (${BUSINESS_PROFILE.synonyms}), confirme com entusiasmo que fazemos. Nunca diga que não fazemos um serviço desta lista.

Regras:
- Responda em português do Brasil, de forma simpática, curta (no máximo 3 frases) e natural, como numa conversa de WhatsApp.
- Nunca invente preços, prazos, descontos ou promessas. Se perguntarem valores, diga que um consultor vai passar um orçamento sob medida.
- Se a pessoa quiser marcar uma conversa ou reunião, diga que um consultor vai entrar em contato para combinar o melhor horário.
- Se for suporte ou reclamação, peça desculpas pelo transtorno e diga que um atendente humano vai assumir.
- Se a pessoa não tiver interesse, agradeça com educação e encerre.
- Não fale de assuntos que não tenham relação com a ${BUSINESS_PROFILE.name}.
- Você é um assistente virtual: nunca diga que é humano.

Responda SEMPRE em JSON com:
- "intent": a intenção da ÚLTIMA mensagem do cliente, uma de: ${INTENTS.join(', ')}.
- "reply": a resposta para enviar ao cliente.`;

/**
 * Autocorreção para a 2.ª tentativa, quando a resposta negou um serviço oferecido. Medido: só
 * baixar a temperatura NÃO resolve (0/4 — o modelo repete o mesmo erro, mais determinístico);
 * mostrar a resposta errada e a correção resolveu 11/11 no caso difícil.
 */
export function correctionMessages(wrongReply) {
  return [
    { role: 'assistant', content: JSON.stringify({ reply: wrongReply }) },
    {
      role: 'system',
      content: `Correção: essa resposta está ERRADA. A ${BUSINESS_PROFILE.name} cria, ela mesma, lojas virtuais (e-commerce), sites, cardápios digitais e sistemas de gestão. Reescreva a resposta confirmando que fazemos o que o cliente pediu.`,
    },
  ];
}

/**
 * Mensagens para o /api/chat: system fixo + histórico recente (cliente = user; equipe/bot =
 * assistant). O nome do cliente vai numa nota curta antes do histórico, fora do system.
 */
export function buildMessages({ clientName, history }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (clientName) messages.push({ role: 'system', content: `Nome do contato no WhatsApp: ${clientName}.` });
  for (const m of history) {
    messages.push({ role: m.sender_type === 'client' ? 'user' : 'assistant', content: m.content });
  }
  return messages;
}
