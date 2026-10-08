/**
 * Motor de copywriting para abordagem via WhatsApp.
 *
 * gerarLinkWhatsApp(lead) -> "https://wa.me/55DDDNUMERO?text=..." ou null (sem telefone válido)
 *
 * A mensagem é montada a partir do grupo do lead (SEM_SITE / COM_SITE) e do segmento
 * detectado pela categoria do Google Maps (alimentação, varejo ou serviços), para que a
 * oferta faça sentido para o negócio abordado.
 *
 * Idioma: o do país da empresa (utils/country.js): português no Brasil/Portugal, inglês nos
 * EUA, Austrália, Reino Unido..., espanhol na Espanha e América hispânica. O "bom dia" segue a
 * hora LOCAL da empresa (a Austrália está ~13h à frente).
 */
import { detectCountry, internationalPhone, localHour } from './country.js';

const REMETENTE = {
  empresa: 'Encoding',
};

// ---------------------------------------------------------------------------
// Segmentação por nicho
// ---------------------------------------------------------------------------

const SEGMENTOS = [
  {
    id: 'alimentacao',
    regex:
      /pizz|restaurante|lanch|hamburg|a[çc]a[ií]|padaria|confeitaria|doceria|\bbar\b|boteco|cafeteria|caf[ée]\b|delivery|sushi|japon|churrasc|marmit|sorvet|pastel|salgad|comida|food|bistr[oô]|cantina|espetinho|choperia|cervejaria/i,
  },
  {
    id: 'varejo',
    regex:
      /loja|boutique|moda|roupa|vestu[aá]rio|cal[çc]ado|pet ?shop|farm[aá]cia|drogaria|perfumaria|cosm[eé]tic|materia(l|is) de constru|home ?center|eletr[oô]n|inform[aá]tica|celular|m[oó]veis|decora[çc]|papelaria|[oó]tica|joalheria|relojoaria|bicicletaria|autope[çc]as|distribuidora|mercado|mercearia|emp[oó]rio|adega|floricultura|brinquedo|suplemento|varej|atacad/i,
  },
];

function detectarSegmento(categoria) {
  const texto = categoria || '';
  return SEGMENTOS.find((segmento) => segmento.regex.test(texto))?.id ?? 'servicos';
}

// ---------------------------------------------------------------------------
// Helpers de dados
// ---------------------------------------------------------------------------

/** Aceita o formato da API (snake_case) e o formato interno (camelCase). */
function normalizarLead(lead) {
  return {
    nome: (lead.name || lead.nome || '').trim(),
    categoria: (lead.category || lead.categoria || '').trim(),
    endereco: lead.address || lead.endereco || '',
    telefone: lead.phone || lead.telefone || '',
    website: lead.website || '',
    nota: Number(lead.rating ?? lead.nota) || null,
    avaliacoes: Number(lead.reviews_count ?? lead.reviewsCount ?? lead.avaliacoes) || null,
    grupo: lead.lead_group || lead.leadGroup || lead.grupo || (lead.website ? 'COM_SITE' : 'SEM_SITE'),
  };
}

/**
 * Converte o telefone do Maps para o formato do wa.me (DDI + número).
 * Empresas de fora levam o DDI pelo país (endereço ou formato local: "(857) 305-3392" de Boston
 * vira 1 857...). Com "+" usa-se como está. O resto é brasileiro: DDI 55 + DDD + número.
 */
export function normalizarTelefoneWhatsApp(telefone, endereco) {
  const texto = internationalPhone(telefone, endereco) ?? '';
  const digitos = texto.replace(/\D/g, '');
  if (texto.startsWith('+')) return digitos.length >= 8 && digitos.length <= 15 ? digitos : null;
  if (!digitos || digitos.startsWith('0')) return null; // 0800 / 0300 não têm WhatsApp
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return null;
}

/** "R. X, 10 - Centro, Curitiba - PR, 80000-000" -> "Curitiba" */
function extrairCidade(endereco) {
  const semCep = (endereco || '').replace(/,?\s*\d{5}-?\d{3}\s*$/, '');
  const match = semCep.match(/,\s*([^,]+?)\s*-\s*[A-Z]{2}\s*$/);
  return match ? match[1].trim() : null;
}

/**
 * Cidade em endereços de fora (Maps em pt-BR):
 *  "301 Lavaca St, Austin, TX 78701, Estados Unidos" -> "Austin"
 *  "Shop 2/40 York St, Sydney NSW 2000, Austrália"  -> "Sydney"
 */
function extrairCidadeExterior(endereco) {
  const partes = String(endereco || '').split(',').map((p) => p.trim()).slice(0, -1); // sem o país
  for (let i = partes.length - 1; i >= 0; i -= 1) {
    const parte = partes[i];
    // "TX 78701" / "ON M5V 2T6": a cidade é o pedaço anterior.
    if (/^[A-Z]{2,3}\s+[\dA-Z]{3,}(\s?[\dA-Z]{3})?$/.test(parte)) return partes[i - 1] ?? null;
    // "Sydney NSW 2000": a cidade vem antes do estado e do código postal.
    const au = parte.match(/^(.+?)\s+[A-Z]{2,3}\s+\d{4}$/);
    if (au) return au[1];
  }
  const candidato = partes.at(-1)?.replace(/\d+/g, '').trim();
  return candidato && candidato.length > 1 ? candidato : null;
}

function extrairDominio(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function saudacaoPorHorario(timeZone, data = new Date()) {
  const hora = localHour(timeZone, data);
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const LOCALE = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };
const formatarNota = (nota, lang = 'pt') =>
  nota.toLocaleString(LOCALE[lang], { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const formatarNumero = (n, lang = 'pt') => n.toLocaleString(LOCALE[lang]);

// ---------------------------------------------------------------------------
// Blocos de copy
// ---------------------------------------------------------------------------

function blocoElogio({ nome, categoria, nota, avaliacoes }) {
  const nicho = categoria ? categoria.toLowerCase() : 'empresa';

  if (nota && nota >= 4.5 && avaliacoes >= 20) {
    return `Encontrei a ${nome} pesquisando por ${nicho} na região e a reputação de vocês chamou atenção: nota ${formatarNota(nota)} com ${formatarNumero(avaliacoes)} avaliações no Google. Isso não se constrói por acaso, parabéns pelo trabalho!`;
  }
  if (nota && nota >= 4) {
    return `Encontrei a ${nome} pesquisando por ${nicho} na região e vi que os clientes avaliam muito bem vocês no Google (nota ${formatarNota(nota)}). Parabéns pelo trabalho!`;
  }
  return `Encontrei a ${nome} pesquisando por ${nicho} na região e gostei muito do que vi do negócio de vocês.`;
}

const OFERTA_SEM_SITE = {
  alimentacao:
    'Um *cardápio digital* com pedidos direto no WhatsApp (sem pagar comissão de aplicativo) ou um *site institucional* otimizado para o Google colocaria a casa de vocês na frente de quem está com fome agora.',
  varejo:
    'Uma *loja virtual em PrestaShop*, otimizada para aparecer no Google, faria a loja de vocês vender 24 horas por dia, inclusive para quem nunca passou na frente da loja física.',
  servicos:
    'Um *site institucional* otimizado para o Google, com botão de orçamento e agendamento pelo WhatsApp, transformaria essas buscas em clientes chegando até vocês.',
};

const DOR_COM_SITE = {
  alimentacao:
    'com pedidos chegando por salão, balcão, telefone e delivery ao mesmo tempo, o controle de comandas, estoque e caixa já está integrado, ou ainda depende de anotação manual e sistemas separados?',
  varejo:
    'o estoque da loja física conversa com o que é vendido no site, ou a equipe ainda precisa conferir e atualizar tudo na mão?',
  servicos:
    'agenda, ordens de serviço e financeiro já estão num sistema só, ou ainda ficam espalhados entre planilhas, papel e WhatsApp?',
};

const OFERTA_COM_SITE = {
  alimentacao:
    'implantamos *sistema de gestão com PDV integrado*: comandas, delivery, estoque e caixa num lugar só, sem retrabalho e sem furo no fechamento',
  varejo:
    'implantamos *ERP com integração de PDV e e-commerce*: estoque, vendas e financeiro sincronizados em tempo real entre loja física e online',
  servicos:
    'implantamos *sistemas de gestão / ERP* sob medida: agenda, ordens de serviço, financeiro e emissão de notas integrados, para a equipe parar de apagar incêndio',
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function templateSemSite(dados, segmento, pais) {
  const cidade = extrairCidade(dados.endereco);
  const nicho = dados.categoria ? dados.categoria.toLowerCase() : 'o serviço de vocês';
  const buscaExemplo = cidade ? `"${nicho} em ${cidade}"` : `"${nicho}" na região`;

  return [
    `${saudacaoPorHorario(pais.timeZone)}, pessoal da *${dados.nome}*! Tudo bem?`,
    blocoElogio(dados),
    `Mas um ponto me preocupou: vocês ainda não têm um site próprio. Hoje, quem pesquisa ${buscaExemplo} no Google acaba clicando nos concorrentes que têm uma plataforma, e esse *tráfego orgânico (gratuito)* está indo para eles todos os dias.`,
    OFERTA_SEM_SITE[segmento],
    `Sou da *${REMETENTE.empresa}* e fazemos exatamente isso para negócios locais. Posso te mostrar em 10 minutos como ficaria para a ${dados.nome}, sem compromisso?`,
  ].join('\n\n');
}

function templateComSite(dados, segmento, pais) {
  const dominio = dados.website ? extrairDominio(dados.website) : null;

  return [
    `${saudacaoPorHorario(pais.timeZone)}, pessoal da *${dados.nome}*! Tudo bem?`,
    blocoElogio(dados),
    `Vi também que vocês já têm presença digital${dominio ? ` com o site ${dominio}` : ''}, o que coloca vocês à frente de boa parte da concorrência. 👏`,
    `Minha curiosidade é sobre o outro lado do balcão: ${DOR_COM_SITE[segmento]}`,
    `Pergunto porque, quando o negócio cresce, a operação interna costuma virar o gargalo. Na *${REMETENTE.empresa}*, ${OFERTA_COM_SITE[segmento]}.`,
    'Faz sentido uma conversa rápida de 15 minutos para eu entender a operação de vocês?',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Inglês e espanhol (empresas de fora)
// ---------------------------------------------------------------------------
// A categoria do Maps vem em português (o scraper usa pt-BR): lá fora fala-se do tipo de
// negócio pelo segmento, nunca com a palavra em português ("pizzaria", "cafeteria").

const TEXTOS = {
  en: {
    saudacao: (hora) => (hora < 12 ? 'Good morning' : hora < 18 ? 'Good afternoon' : 'Good evening'),
    abertura: (nome, saud) => `${saud}, *${nome}* team! Hope you're all doing well.`,
    lugar: { alimentacao: 'places to eat', varejo: 'local stores', servicos: 'local businesses' },
    perto: (cidade) => (cidade ? `in ${cidade}` : 'in your area'),
    elogioTop: (nome, lugar, onde, nota, n) =>
      `I came across ${nome} while looking for ${lugar} ${onde}, and your reputation really stood out: ${nota} stars from ${n} Google reviews. That doesn't happen by accident, so congrats on the great work!`,
    elogioBom: (nome, lugar, onde, nota) =>
      `I came across ${nome} while looking for ${lugar} ${onde}, and I noticed your customers rate you really well on Google (${nota} stars). Great work!`,
    elogio: (nome, lugar, onde) => `I came across ${nome} while looking for ${lugar} ${onde} and really liked what I saw.`,
    semSite: (onde) =>
      `One thing caught my attention, though: you don't have your own website yet. Today, when people ${onde} search Google for what you offer, they end up clicking on competitors who do, and all that *free organic traffic* goes to them every single day.`,
    ofertaSemSite: {
      alimentacao:
        'A *digital menu* with online ordering (no third-party delivery app fees) or a *website* optimized for Google would put you right in front of hungry customers at the exact moment they are searching.',
      varejo: 'An *online store* optimized to show up on Google would let you sell 24/7, even to people who have never walked past your shop.',
      servicos: 'A *professional website* optimized for Google, with quote requests and online booking, would turn those searches into customers reaching out to you.',
    },
    fechoSemSite: (empresa, nome) =>
      `I'm with *${empresa}*, and this is exactly what we build for local businesses. Could I show you in 10 minutes what it would look like for ${nome}? No strings attached.`,
    presenca: (dominio) => `I also saw you already have an online presence${dominio ? ` at ${dominio}` : ''}, which puts you ahead of a lot of the competition. 👏`,
    curiosidade: (dor) => `What I'm curious about is the other side of the counter: ${dor}`,
    dor: {
      alimentacao:
        'with orders coming in from the dining room, the counter, the phone and delivery all at once, are tickets, inventory and the register already integrated, or is it still handwritten notes and separate systems?',
      varejo: 'does your in-store inventory sync with what sells online, or does the team still have to check and update everything by hand?',
      servicos: 'are scheduling, work orders and billing all in one system, or still spread across spreadsheets, paper and messages?',
    },
    porque: (empresa, oferta) => `I ask because as a business grows, internal operations tend to become the bottleneck. At *${empresa}*, ${oferta}.`,
    oferta: {
      alimentacao: 'we set up *POS-integrated management systems*: orders, delivery, inventory and cash register in one place, with no double work and no end-of-day surprises',
      varejo: 'we implement *ERP with POS and e-commerce integration*: inventory, sales and finances synced in real time between your store and online',
      servicos: 'we build custom *management systems / ERP*: scheduling, work orders, billing and invoicing integrated, so your team can stop putting out fires',
    },
    convite: 'Would a quick 15-minute chat make sense, so I can understand how you operate?',
  },
  es: {
    saudacao: (hora) => (hora < 12 ? 'Buenos días' : hora < 20 ? 'Buenas tardes' : 'Buenas noches'),
    abertura: (nome, saud) => `${saud}, equipo de *${nome}*. ¿Cómo están?`,
    lugar: { alimentacao: 'lugares para comer', varejo: 'tiendas', servicos: 'negocios locales' },
    perto: (cidade) => (cidade ? `en ${cidade}` : 'en la zona'),
    elogioTop: (nome, lugar, onde, nota, n) =>
      `Encontré ${nome} buscando ${lugar} ${onde} y su reputación me llamó la atención: ${nota} estrellas con ${n} reseñas en Google. Eso no se construye por casualidad, ¡felicitaciones por el trabajo!`,
    elogioBom: (nome, lugar, onde, nota) =>
      `Encontré ${nome} buscando ${lugar} ${onde} y vi que sus clientes los califican muy bien en Google (${nota} estrellas). ¡Felicitaciones!`,
    elogio: (nome, lugar, onde) => `Encontré ${nome} buscando ${lugar} ${onde} y me gustó mucho lo que vi del negocio.`,
    semSite: (onde) =>
      `Pero algo me llamó la atención: todavía no tienen sitio web propio. Hoy, quien busca en Google lo que ustedes ofrecen ${onde} termina entrando en la competencia que sí lo tiene, y ese *tráfico orgánico (gratuito)* se lo llevan ellos todos los días.`,
    ofertaSemSite: {
      alimentacao:
        'Un *menú digital* con pedidos directos por WhatsApp (sin pagar comisión a aplicaciones) o un *sitio web* optimizado para Google los pondría frente a quien tiene hambre justo en ese momento.',
      varejo: 'Una *tienda online* optimizada para aparecer en Google les permitiría vender las 24 horas, incluso a quien nunca pasó frente a la tienda física.',
      servicos: 'Un *sitio web profesional* optimizado para Google, con botón de presupuesto y reservas por WhatsApp, convertiría esas búsquedas en clientes contactándolos.',
    },
    fechoSemSite: (empresa, nome) =>
      `Soy de *${empresa}* y hacemos exactamente esto para negocios locales. ¿Les puedo mostrar en 10 minutos cómo quedaría para ${nome}, sin compromiso?`,
    presenca: (dominio) => `Vi también que ya tienen presencia digital${dominio ? ` con el sitio ${dominio}` : ''}, lo que los pone por delante de buena parte de la competencia. 👏`,
    curiosidade: (dor) => `Mi curiosidad es sobre el otro lado del mostrador: ${dor}`,
    dor: {
      alimentacao:
        'con pedidos llegando por el salón, el mostrador, el teléfono y el delivery al mismo tiempo, ¿las comandas, el inventario y la caja ya están integrados, o todavía dependen de anotaciones a mano y sistemas separados?',
      varejo: '¿el inventario de la tienda física se sincroniza con lo que se vende online, o el equipo todavía tiene que revisar y actualizar todo a mano?',
      servicos: '¿la agenda, las órdenes de servicio y las finanzas ya están en un solo sistema, o siguen repartidas entre planillas, papel y WhatsApp?',
    },
    porque: (empresa, oferta) => `Pregunto porque, cuando el negocio crece, la operación interna suele convertirse en el cuello de botella. En *${empresa}*, ${oferta}.`,
    oferta: {
      alimentacao: 'implementamos *sistemas de gestión con punto de venta integrado*: comandas, delivery, inventario y caja en un solo lugar, sin retrabajo y sin sorpresas al cierre',
      varejo: 'implementamos *ERP con integración de punto de venta y e-commerce*: inventario, ventas y finanzas sincronizados en tiempo real entre la tienda física y la online',
      servicos: 'desarrollamos *sistemas de gestión / ERP* a medida: agenda, órdenes de servicio, finanzas y facturación integrados, para que el equipo deje de apagar incendios',
    },
    convite: '¿Tendría sentido una conversación rápida de 15 minutos para entender cómo operan?',
  },
};

function templateExterior(dados, segmento, pais) {
  const t = TEXTOS[pais.lang];
  const cidade = extrairCidadeExterior(dados.endereco);
  const onde = t.perto(cidade);
  const lugar = t.lugar[segmento];
  const { nome, nota, avaliacoes } = dados;
  const elogio =
    nota && nota >= 4.5 && avaliacoes >= 20
      ? t.elogioTop(nome, lugar, onde, formatarNota(nota, pais.lang), formatarNumero(avaliacoes, pais.lang))
      : nota && nota >= 4
        ? t.elogioBom(nome, lugar, onde, formatarNota(nota, pais.lang))
        : t.elogio(nome, lugar, onde);
  const abertura = t.abertura(nome, t.saudacao(localHour(pais.timeZone)));

  if (dados.grupo === 'SEM_SITE') {
    return [abertura, elogio, t.semSite(onde), t.ofertaSemSite[segmento], t.fechoSemSite(REMETENTE.empresa, nome)].join('\n\n');
  }
  const dominio = dados.website ? extrairDominio(dados.website) : null;
  return [abertura, elogio, t.presenca(dominio), t.curiosidade(t.dor[segmento]), t.porque(REMETENTE.empresa, t.oferta[segmento]), t.convite].join('\n\n');
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** País/idioma em que a mensagem de um lead sai (para mostrar no botão). */
export const paisDoLead = (lead) => detectCountry({ address: lead.address ?? lead.endereco, phone: lead.phone ?? lead.telefone });

/** Gera apenas o texto da mensagem (útil para pré-visualizar ou copiar), no idioma da empresa. */
export function gerarMensagemWhatsApp(lead) {
  const dados = normalizarLead(lead);
  const segmento = detectarSegmento(dados.categoria);
  const pais = paisDoLead(lead);
  if (pais.lang === 'en' || pais.lang === 'es') return templateExterior(dados, segmento, pais);
  return dados.grupo === 'SEM_SITE' ? templateSemSite(dados, segmento, pais) : templateComSite(dados, segmento, pais);
}

/**
 * Gera o link wa.me com a mensagem persuasiva já codificada.
 * @param {object} lead Lead vindo de GET /api/leads.
 * @returns {string|null} URL pronta para <a href>, ou null se o telefone não for válido para WhatsApp.
 */
export function gerarLinkWhatsApp(lead) {
  if (!lead) return null;

  const numero = normalizarTelefoneWhatsApp(lead.phone ?? lead.telefone, lead.address ?? lead.endereco);
  if (!numero) return null;

  const mensagem = gerarMensagemWhatsApp(lead);
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
}
