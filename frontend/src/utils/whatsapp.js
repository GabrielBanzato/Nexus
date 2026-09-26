/**
 * Motor de copywriting para abordagem via WhatsApp.
 *
 * gerarLinkWhatsApp(lead) -> "https://wa.me/55DDDNUMERO?text=..." ou null (sem telefone válido)
 *
 * A mensagem é montada a partir do grupo do lead (SEM_SITE / COM_SITE) e do segmento
 * detectado pela categoria do Google Maps (alimentação, varejo ou serviços), para que a
 * oferta faça sentido para o negócio abordado.
 */

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

/** Converte o telefone do Maps para o formato do wa.me: DDI 55 + DDD + número. */
export function normalizarTelefoneWhatsApp(telefone) {
  const digitos = (telefone || '').replace(/\D/g, '');
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

function extrairDominio(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function saudacaoPorHorario(data = new Date()) {
  const hora = data.getHours();
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

const formatarNota = (nota) =>
  nota.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const formatarNumero = (n) => n.toLocaleString('pt-BR');

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

function templateSemSite(dados, segmento) {
  const cidade = extrairCidade(dados.endereco);
  const nicho = dados.categoria ? dados.categoria.toLowerCase() : 'o serviço de vocês';
  const buscaExemplo = cidade ? `"${nicho} em ${cidade}"` : `"${nicho}" na região`;

  return [
    `${saudacaoPorHorario()}, pessoal da *${dados.nome}*! Tudo bem?`,
    blocoElogio(dados),
    `Mas um ponto me preocupou: vocês ainda não têm um site próprio. Hoje, quem pesquisa ${buscaExemplo} no Google acaba clicando nos concorrentes que têm uma plataforma, e esse *tráfego orgânico (gratuito)* está indo para eles todos os dias.`,
    OFERTA_SEM_SITE[segmento],
    `Sou da *${REMETENTE.empresa}* e fazemos exatamente isso para negócios locais. Posso te mostrar em 10 minutos como ficaria para a ${dados.nome}, sem compromisso?`,
  ].join('\n\n');
}

function templateComSite(dados, segmento) {
  const dominio = dados.website ? extrairDominio(dados.website) : null;

  return [
    `${saudacaoPorHorario()}, pessoal da *${dados.nome}*! Tudo bem?`,
    blocoElogio(dados),
    `Vi também que vocês já têm presença digital${dominio ? ` com o site ${dominio}` : ''}, o que coloca vocês à frente de boa parte da concorrência. 👏`,
    `Minha curiosidade é sobre o outro lado do balcão: ${DOR_COM_SITE[segmento]}`,
    `Pergunto porque, quando o negócio cresce, a operação interna costuma virar o gargalo. Na *${REMETENTE.empresa}*, ${OFERTA_COM_SITE[segmento]}.`,
    'Faz sentido uma conversa rápida de 15 minutos para eu entender a operação de vocês?',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** Gera apenas o texto da mensagem (útil para pré-visualizar ou copiar). */
export function gerarMensagemWhatsApp(lead) {
  const dados = normalizarLead(lead);
  const segmento = detectarSegmento(dados.categoria);
  return dados.grupo === 'SEM_SITE' ? templateSemSite(dados, segmento) : templateComSite(dados, segmento);
}

/**
 * Gera o link wa.me com a mensagem persuasiva já codificada.
 * @param {object} lead Lead vindo de GET /api/leads.
 * @returns {string|null} URL pronta para <a href>, ou null se o telefone não for válido para WhatsApp.
 */
export function gerarLinkWhatsApp(lead) {
  if (!lead) return null;

  const numero = normalizarTelefoneWhatsApp(lead.phone ?? lead.telefone);
  if (!numero) return null;

  const mensagem = gerarMensagemWhatsApp(lead);
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
}
