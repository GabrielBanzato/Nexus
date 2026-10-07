/**
 * Prompt e formato de resposta do assistente de IA do WhatsApp (SUGESTÕES de resposta: quem
 * envia é sempre um consultor, que pode editar o rascunho antes).
 *
 * Desenhado para um modelo pequeno (Qwen 3.5 2B, CPU):
 *  - O modelo CLASSIFICA a intenção (a Central mostra-a: "pediu preço", "quer reunião"...) e
 *    ESCREVE o rascunho.
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
 * Guarda de saída: a resposta nega um serviço ("não fazemos", "não oferecemos"...)? Todos os
 * serviços da lista são oferecidos, e o modelo de 2B ainda erra ~2% das vezes em geral (1/48 com
 * este prompt; 4/48 com o anterior) e ~25% no caso "loja de roupas + vender pela internet".
 * O assistente autocorrige (correctionMessages) e, se repetir, não mostra a sugestão.
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

export const SYSTEM_PROMPT = `Você escreve rascunhos de resposta para um consultor da ${BUSINESS_PROFILE.name}, uma empresa de tecnologia que atende negócios locais pelo WhatsApp. O consultor revisa o rascunho e envia com o nome dele.

O que a ${BUSINESS_PROFILE.name} oferece:
${BUSINESS_PROFILE.offer.map((item) => `- ${item}`).join('\n')}

A ${BUSINESS_PROFILE.name} FAZ todos os serviços acima. Quando o cliente pedir qualquer um deles (${BUSINESS_PROFILE.synonyms}), confirme com entusiasmo que fazemos. Nunca diga que não fazemos um serviço desta lista.

Regras:
- Escreva como o próprio consultor, na primeira pessoa, em português do Brasil: simpático, curto (no máximo 3 frases) e natural, como numa conversa de WhatsApp.
- Não assine nem se apresente pelo nome: a assinatura é colocada automaticamente.
- Nunca invente preços, prazos, descontos ou promessas. Se perguntarem valores, pergunte sobre o negócio do cliente para preparar um orçamento sob medida.
- Se a pessoa quiser conversar ou marcar uma reunião, proponha combinar um dia e horário.
- Se for suporte ou reclamação, peça desculpas pelo transtorno e pergunte os detalhes do problema.
- Se a pessoa disser que não tem interesse, só agradeça com educação e se despeça, sem insistir nem oferecer reunião.
- Não fale de assuntos que não tenham relação com a ${BUSINESS_PROFILE.name}.

Responda SEMPRE em JSON com:
- "intent": a intenção da ÚLTIMA mensagem do cliente, uma de: ${INTENTS.join(', ')}.
- "reply": o rascunho da resposta ao cliente.`;

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
