/**
 * Mensagem de primeiro contato pelo WhatsApp (curta, no idioma da empresa).
 *
 * gerarLinkWhatsApp(lead) -> "https://wa.me/55DDDNUMERO?text=..." ou null (sem telefone válido)
 *
 * A mensagem é montada a partir do grupo do lead (SEM_SITE / COM_SITE) e do segmento
 * detectado pela categoria do Google Maps (alimentação, varejo ou serviços), para que a
 * oferta numa frase faça sentido para o negócio abordado.
 *
 * Idioma: o do país da empresa (utils/country.js): português no Brasil/Portugal, inglês nos
 * EUA, Austrália, Reino Unido..., espanhol na Espanha e América hispânica. O "bom dia" segue a
 * hora LOCAL da empresa (a Austrália está ~13h à frente).
 */
import { detectCountry, internationalPhone, localHour } from './country.js';

const REMETENTE = {
  empresa: 'Nexus',
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

const LOCALE = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };
const formatarNota = (nota, lang = 'pt') =>
  nota.toLocaleString(LOCALE[lang], { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---------------------------------------------------------------------------
// Copy: curta, humana, sem jargão — pede licença em vez de vender
// ---------------------------------------------------------------------------
// Lição do campo: a mensagem longa e "completa" não era lida (e um textão de um número
// desconhecido parece golpe). Agora são 4 linhas curtas: saudação, de onde veio o contacto
// (elogio real, se houver), o que fazemos numa frase e uma pergunta fácil de responder.
//
// Variações: cada lead recebe uma combinação de frases (fixa para o mesmo lead). Dezenas de
// mensagens IDÊNTICAS de um mesmo número são um dos sinais que o WhatsApp usa para banir.

/** Índice estável a partir do nome (o mesmo lead → a mesma mensagem; leads diferentes variam). */
function semente(texto) {
  let h = 2166136261;
  for (const ch of texto) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}
const escolher = (lista, seed, slot) => lista[(seed >>> (slot * 3)) % lista.length];

/** Avaliações que valem um elogio (poucas ou más não se mencionam). */
const boaReputacao = ({ nota, avaliacoes }) => nota >= 4.3 && avaliacoes >= 10;

const COPY = {
  pt: {
    saudacao: (h) => (h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'),
    abertura: [(s) => `${s}! Tudo bem?`, (s) => `Oi, ${s.toLowerCase()}! Tudo certo?`, (s) => `${s}, tudo bem por aí?`],
    elogio: [
      (n, nota, qtd) => `Vi a *${n}* no Google, nota ${nota} com ${qtd} avaliações. Parabéns, isso é raro!`,
      (n, nota) => `Achei a *${n}* no Google e as avaliações de vocês são ótimas (${nota} ⭐).`,
      (n, nota, qtd) => `Encontrei a *${n}* no Google: ${nota} estrelas com ${qtd} avaliações, mandaram bem!`,
    ],
    contato: [(n) => `Encontrei a *${n}* aqui no Google.`, (n) => `Vi a *${n}* no Google Maps.`, (n) => `Achei a *${n}* pesquisando no Google.`],
    semSite: [
      (empresa, beneficio) => `Reparei que vocês ainda não têm site. Sou da *${empresa}* e ajudo negócios como o de vocês a ${beneficio}.`,
      (empresa, beneficio) => `Notei que ainda não têm um site próprio. Aqui é da *${empresa}*, a gente ajuda negócios locais a ${beneficio}.`,
    ],
    beneficio: {
      alimentacao: 'receber pedidos direto no WhatsApp, sem taxa de aplicativo',
      varejo: 'vender pela internet também',
      servicos: 'receber mais clientes pelo Google',
    },
    comSite: [
      (empresa, alvo, dor) => `Vi que vocês já têm site 👏. Sou da *${empresa}* e a gente monta sistemas pra ${alvo}: ${dor}.`,
      (empresa, alvo, dor) => `Dei uma olhada no site de vocês também, ficou bacana. Aqui é da *${empresa}*, fazemos sistemas pra ${alvo}: ${dor}.`,
    ],
    alvo: { alimentacao: 'restaurantes', varejo: 'lojas', servicos: 'empresas de serviço' },
    dor: {
      alimentacao: 'comandas, delivery e caixa num lugar só',
      varejo: 'estoque da loja e do site sempre sincronizados',
      servicos: 'agenda, orçamentos e financeiro juntos',
    },
    fechoSemSite: ['Posso te mandar uma ideia? É rapidinho e sem compromisso 🙂', 'Quer que eu te mostre como ficaria? Leva 2 minutinhos.', 'Posso te enviar um exemplo por aqui mesmo?'],
    fechoComSite: ['Faz sentido eu te mostrar como funciona?', 'Posso te mandar um exemplo rápido?', 'Quer ver como ficaria pra vocês? É rapidinho.'],
  },
  en: {
    saudacao: (h) => (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'),
    abertura: [(s) => `${s}! Hope you're doing well.`, (s) => `Hi there, ${s.toLowerCase()}!`, (s) => `${s}! Hope your week is going well.`],
    elogio: [
      (n, nota, qtd) => `Came across *${n}* on Google: ${nota} stars from ${qtd} reviews. Impressive!`,
      (n, nota) => `Found *${n}* on Google Maps, and your reviews are great (${nota} ⭐).`,
      (n, nota, qtd) => `I saw *${n}* on Google, ${nota} stars with ${qtd} reviews. Nice work!`,
    ],
    contato: [(n) => `Came across *${n}* on Google.`, (n) => `Found *${n}* on Google Maps.`, (n) => `I saw *${n}* on Google.`],
    semSite: [
      (empresa, beneficio) => `I noticed you don't have a website yet. I'm with *${empresa}*, and we help businesses like yours ${beneficio}.`,
      (empresa, beneficio) => `Looks like you don't have your own website yet. We're *${empresa}*, and we help local businesses ${beneficio}.`,
    ],
    beneficio: {
      alimentacao: 'take orders online without delivery-app fees',
      varejo: 'sell online too',
      servicos: 'get more customers from Google',
    },
    comSite: [
      (empresa, alvo, dor) => `Saw your website too, nice work 👏. I'm with *${empresa}*, and we build systems for ${alvo}: ${dor}.`,
      (empresa, alvo, dor) => `Checked out your website as well, looks good. We're *${empresa}*, and we build systems for ${alvo}: ${dor}.`,
    ],
    alvo: { alimentacao: 'restaurants', varejo: 'stores', servicos: 'service businesses' },
    dor: {
      alimentacao: 'orders, delivery and the register in one place',
      varejo: 'in-store and online inventory always in sync',
      servicos: 'scheduling, quotes and billing together',
    },
    fechoSemSite: ['Can I send you a quick idea? No strings attached 🙂', 'Mind if I show you what it could look like? Takes 2 minutes.', 'Can I send you a quick example here?'],
    fechoComSite: ['Would it make sense to show you how it works?', 'Can I send you a quick example?', 'Want to see what it could look like for you? Super quick.'],
  },
  es: {
    saudacao: (h) => (h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches'),
    abertura: [(s) => `¡${s}! ¿Cómo están?`, (s) => `Hola, ¡${s.toLowerCase()}! ¿Todo bien?`, (s) => `¡${s}! Espero que estén muy bien.`],
    elogio: [
      (n, nota, qtd) => `Vi *${n}* en Google: ${nota} estrellas con ${qtd} reseñas. ¡Felicitaciones!`,
      (n, nota) => `Encontré *${n}* en Google y sus reseñas son excelentes (${nota} ⭐).`,
      (n, nota, qtd) => `Encontré *${n}* en Google, ${nota} estrellas con ${qtd} reseñas. ¡Muy bien!`,
    ],
    contato: [(n) => `Encontré *${n}* en Google.`, (n) => `Vi *${n}* en Google Maps.`, (n) => `Encontré *${n}* buscando en Google.`],
    semSite: [
      (empresa, beneficio) => `Vi que todavía no tienen sitio web. Soy de *${empresa}* y ayudamos a negocios como el suyo a ${beneficio}.`,
      (empresa, beneficio) => `Noté que aún no tienen página web propia. Somos *${empresa}* y ayudamos a negocios locales a ${beneficio}.`,
    ],
    beneficio: {
      alimentacao: 'recibir pedidos directo por WhatsApp, sin comisión de aplicaciones',
      varejo: 'vender también por internet',
      servicos: 'conseguir más clientes desde Google',
    },
    comSite: [
      (empresa, alvo, dor) => `Vi que ya tienen sitio web 👏. Soy de *${empresa}* y armamos sistemas para ${alvo}: ${dor}.`,
      (empresa, alvo, dor) => `Le eché un vistazo a su web, quedó muy bien. Somos *${empresa}* y hacemos sistemas para ${alvo}: ${dor}.`,
    ],
    alvo: { alimentacao: 'restaurantes', varejo: 'tiendas', servicos: 'empresas de servicios' },
    dor: {
      alimentacao: 'comandas, delivery y caja en un solo lugar',
      varejo: 'inventario de la tienda y de la web siempre sincronizados',
      servicos: 'agenda, presupuestos y finanzas juntos',
    },
    fechoSemSite: ['¿Les puedo enviar una idea? Es rápido y sin compromiso 🙂', '¿Quieren que les muestre cómo quedaría? Son 2 minutos.', '¿Les mando un ejemplo por aquí mismo?'],
    fechoComSite: ['¿Tendría sentido mostrarles cómo funciona?', '¿Les puedo enviar un ejemplo rápido?', '¿Quieren ver cómo quedaría para ustedes? Es rápido.'],
  },
};

function montarMensagem(dados, segmento, pais) {
  const t = COPY[pais.lang] ?? COPY.pt;
  const seed = semente(dados.nome || dados.telefone || 'lead');
  const nome = dados.nome || 'empresa';
  const saud = t.saudacao(localHour(pais.timeZone));
  const contato = boaReputacao(dados)
    ? escolher(t.elogio, seed, 1)(nome, formatarNota(dados.nota, pais.lang), dados.avaliacoes.toLocaleString(LOCALE[pais.lang]))
    : escolher(t.contato, seed, 1)(nome);
  const oferta =
    dados.grupo === 'SEM_SITE'
      ? escolher(t.semSite, seed, 2)(REMETENTE.empresa, t.beneficio[segmento])
      : escolher(t.comSite, seed, 2)(REMETENTE.empresa, t.alvo[segmento], t.dor[segmento]);
  const fecho = escolher(dados.grupo === 'SEM_SITE' ? t.fechoSemSite : t.fechoComSite, seed, 3);
  return [escolher(t.abertura, seed, 0)(saud), contato, oferta, fecho].join('\n\n');
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** País/idioma em que a mensagem de um lead sai (para mostrar no botão). */
export const paisDoLead = (lead) => detectCountry({ address: lead.address ?? lead.endereco, phone: lead.phone ?? lead.telefone });

/** Gera apenas o texto da mensagem (útil para pré-visualizar ou copiar), no idioma da empresa. */
export function gerarMensagemWhatsApp(lead) {
  const dados = normalizarLead(lead);
  return montarMensagem(dados, detectarSegmento(dados.categoria), paisDoLead(lead));
}

/**
 * Gera o link wa.me com a mensagem já codificada.
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
