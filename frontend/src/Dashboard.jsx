import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveRestore,
  CheckCheck,
  Circle,
  CircleCheck,
  EyeOff,
  History,
  PhoneCall,
  CircleX,
  Crosshair,
  Download,
  Handshake,
  Trophy,
  Ban,
  Globe,
  LoaderCircle,
  MapPin,
  MapPinned,
  MessageCircle,
  PhoneOff,
  Radar,
  RefreshCw,
  Search,
  SearchX,
  SlidersHorizontal,
  Star,
  Tag,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  fetchAllLeads,
  fetchLeadSearches,
  fetchLeads,
  fetchScrapeJob,
  qualifyLead,
  setLeadHidden,
  startScrape,
  updateLeadStatus,
} from './lib/api.js';
import { useAuth } from './lib/auth.jsx';
import { formatRelative } from './lib/labels.js';
import { useHashRoute } from './lib/useHashRoute.js';
import { exportLeadsCsv } from './utils/csv.js';
import { gerarLinkWhatsApp } from './utils/whatsapp.js';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const PAGE_SIZE = 60;

const SCRAPE_POLL_INTERVAL_MS = 2500;
const SCRAPE_MAX_POLL_FAILURES = 5;
const MAX_RESULTS_OPTIONS = [20, 50, 100];
const ACTIVE_JOB_STORAGE_KEY = 'nexus:activeScrapeJob';
const TOAST_DURATION_MS = 8000;

const GROUP_OPTIONS = [
  { value: '', label: 'Com e sem site' },
  { value: 'SEM_SITE', label: 'Sem site' },
  { value: 'COM_SITE', label: 'Com site' },
];

const CONTACT_OPTIONS = [
  { value: 'todos', label: 'Todos os contatos' },
  { value: 'nao_contatados', label: 'Não contatados' },
  { value: 'contatados', label: 'Já contatados' },
];

const VISIBILITY_OPTIONS = [
  { value: 'ativos', label: 'Leads ativos' },
  { value: 'ocultos', label: 'Ocultos / arquivados' },
];

const DEFAULT_FILTERS = { nicho: '', grupo: '', contato: 'todos', visibilidade: 'ativos', busca: '' };

// Status que o toggle "contatado" pode alternar. Os demais (negociação, cliente, descartado)
// são geridos pela Triagem/Pipeline e não devem ser desfeitos a partir daqui.
const TOGGLEABLE_CONTACT = new Set(['NOVO', 'CONTATADO']);

const numberFormat = new Intl.NumberFormat('pt-BR');
const ratingFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---------------------------------------------------------------------------
// Persistência local
// ---------------------------------------------------------------------------

// Guarda o job ativo para retomar o acompanhamento se a página for recarregada.
const jobStorage = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY));
    } catch {
      return null;
    }
  },
  write(job) {
    try {
      localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify(job));
    } catch {
      // Storage indisponível: o acompanhamento segue apenas nesta aba.
    }
  },
  clear() {
    try {
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove CEP e país: "R. X, 10 - Centro, Campinas - SP, 13000-000" -> "R. X, 10 - Centro, Campinas - SP". */
function shortAddress(address) {
  if (!address) return 'Endereço não informado';
  return address
    .replace(/,?\s*\d{5}-?\d{3}\s*$/, '')
    .replace(/,?\s*Brasil\s*$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useDebouncedValue(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Dispara o scraper e acompanha o job até o fim.
 * O POST /api/scrape responde imediatamente (202); o término real é
 * detectado consultando GET /api/scrape/:jobId até status DONE ou FAILED.
 */
function useScrapeJob({ onFinish }) {
  const [job, setJob] = useState(() => jobStorage.read());
  const [submitting, setSubmitting] = useState(false);

  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  });

  const jobId = job?.id;

  useEffect(() => {
    if (!jobId) return undefined;

    let cancelled = false;
    let timer;
    let failures = 0;

    const finish = (finalJob, errorMessage) => {
      jobStorage.clear();
      setJob(null);
      onFinishRef.current(finalJob, errorMessage);
    };

    const poll = async () => {
      try {
        const data = await fetchScrapeJob(jobId);
        if (cancelled) return;
        failures = 0;

        if (data.status === 'DONE' || data.status === 'FAILED') {
          finish(data);
          return;
        }
        setJob((current) => (current ? { ...current, ...data } : current));
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        if (err.status === 404 || failures >= SCRAPE_MAX_POLL_FAILURES) {
          finish(null, err.message);
          return;
        }
      }
      timer = setTimeout(poll, SCRAPE_POLL_INTERVAL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  const start = useCallback(async ({ termo, maxResultados }) => {
    setSubmitting(true);
    try {
      const response = await startScrape({ termo, maxResultados });
      const newJob = {
        id: response.jobId,
        status: 'PENDING',
        search_term: response.termo,
        max_results: response.maxResultados,
        found: 0,
        position: response.posicaoNaFila,
      };
      jobStorage.write(newJob);
      setJob(newJob);
    } finally {
      setSubmitting(false);
    }
  }, []);

  return { job, start, isBusy: submitting || Boolean(job) };
}

// ---------------------------------------------------------------------------
// Estilos compartilhados
// ---------------------------------------------------------------------------

const fieldClass =
  'h-11 w-full rounded-xl border border-neutral-800 bg-[#141414] text-sm text-neutral-100 placeholder:text-neutral-500 transition outline-none focus:border-red-700 focus:ring-4 focus:ring-red-900/30 disabled:cursor-not-allowed disabled:opacity-60';

const secondaryButtonClass =
  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-neutral-800 px-3 text-sm font-medium whitespace-nowrap text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-800/60 hover:text-white';

function SelectChevron() {
  return (
    <svg
      className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-neutral-500"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Componentes de UI
// ---------------------------------------------------------------------------

/** Cabeçalho da página de prospecção (a marca e o "Sair" ficam na navegação global). */
function Header({ loaded, total, counts, isLoading, onExport, exporting }) {
  return (
    <header>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Prospecção</h1>
          <p className="mt-1 text-sm text-neutral-400">Leads extraídos do Google Maps, prontos para abordagem.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-2 rounded-full bg-neutral-800/80 px-3 py-1.5 font-medium text-neutral-400 ring-1 ring-neutral-700/60">
            {isLoading ? (
              <LoaderCircle className="size-3.5 animate-spin text-red-500" />
            ) : (
              <span className="size-2 rounded-full bg-red-600 shadow-[0_0_8px] shadow-red-600" />
            )}
            <span>
              <strong className="font-semibold text-white">{numberFormat.format(loaded)}</strong>
              {' de '}
              <strong className="font-semibold text-white">{numberFormat.format(total)}</strong> leads carregados
            </span>
          </span>
          <span className="rounded-full bg-red-950/60 px-3 py-1.5 font-medium text-red-300 ring-1 ring-red-900/70">
            {numberFormat.format(counts.SEM_SITE)} sem site
          </span>
          <span className="rounded-full bg-emerald-950/40 px-3 py-1.5 font-medium text-emerald-400 ring-1 ring-emerald-900/60">
            {numberFormat.format(counts.COM_SITE)} com site
          </span>

          <span className="mx-1 hidden h-6 w-px bg-neutral-800 sm:block" aria-hidden="true" />

          <button
            type="button"
            onClick={onExport}
            disabled={exporting || total === 0}
            title="Exporta todos os leads dos filtros ativos (compatível com Público Personalizado do Meta Ads)"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-700 px-3 font-medium text-neutral-200 transition hover:border-red-800 hover:bg-red-950/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            Exportar Leads (CSV)
          </button>
        </div>
      </div>
    </header>
  );
}

function ScrapeProgress({ job }) {
  const found = job.found ?? 0;
  const max = job.max_results || 0;
  const percent = max ? Math.min(100, Math.round((found / max) * 100)) : 0;
  const queued = job.status === 'PENDING' && job.position > 1;

  return (
    <div className="mt-4 flex items-center gap-4 rounded-xl border border-red-900/40 bg-red-950/20 p-4">
      <span className="relative flex size-3 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex size-3 rounded-full bg-red-600" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
          <p className="truncate text-neutral-300">
            {queued ? 'Na fila, aguardando outra varredura terminar: ' : 'Varrendo o mapa: '}
            <span className="font-semibold text-white">“{job.search_term}”</span>
          </p>
          <p className="shrink-0 text-neutral-400">
            <span className="font-semibold text-white">{numberFormat.format(found)}</span>
            {max ? ` / ${numberFormat.format(max)}` : ''} empresas extraídas
          </p>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-linear-to-r from-red-800 to-red-500 transition-[width] duration-700"
            style={{ width: `${Math.max(percent, 3)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function RadarSearch({ job, isBusy, onStart }) {
  const [term, setTerm] = useState('');
  const [maxResults, setMaxResults] = useState(MAX_RESULTS_OPTIONS[1]);
  const [formError, setFormError] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const termo = term.trim();
    if (termo.length < 3) {
      setFormError('Digite um termo com pelo menos 3 caracteres (ex: "Pizzarias em Curitiba").');
      return;
    }

    setFormError(null);
    try {
      await onStart({ termo, maxResultados: maxResults });
      setTerm('');
    } catch (err) {
      setFormError(err.message);
    }
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-neutral-800 bg-[#1a1a1a] p-5 shadow-2xl shadow-black/40 sm:p-6">
      {/* Brilho vermelho sutil no canto: identidade Nexus */}
      <div className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-red-800/20 blur-3xl" />

      <div className="relative">
        <div className="flex items-center gap-2.5">
          <Crosshair className="size-5 text-red-600" />
          <h2 className="text-base font-semibold text-white">Radar de Busca</h2>
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Varre o Google Maps pelo nicho e cidade informados e importa as empresas direto para o painel.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3 lg:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Termo de busca</span>
            <MapPin className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Ex: Oficinas mecânicas em Curitiba"
              disabled={isBusy}
              className={`${fieldClass} pr-4 pl-10`}
            />
          </label>

          <label className="relative lg:w-48">
            <span className="sr-only">Quantidade máxima de resultados</span>
            <select
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              disabled={isBusy}
              className={`${fieldClass} cursor-pointer appearance-none pr-9 pl-4 font-medium text-neutral-300`}
            >
              {MAX_RESULTS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Até {n} resultados
                </option>
              ))}
            </select>
            <SelectChevron />
          </label>

          <button
            type="submit"
            disabled={isBusy}
            aria-busy={isBusy}
            className="inline-flex h-11 min-w-64 items-center justify-center gap-2 rounded-xl bg-red-800 px-5 text-sm font-semibold whitespace-nowrap text-white shadow-lg shadow-red-950/50 ring-1 ring-red-600/30 transition hover:bg-red-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-red-900/60 disabled:text-red-100/80 disabled:active:scale-100"
          >
            {isBusy ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Buscando alvos no mapa...
              </>
            ) : (
              <>
                <Radar className="size-4" />
                Iniciar Varredura Nexus
              </>
            )}
          </button>
        </form>

        {formError && (
          <p className="mt-3 flex items-center gap-2 text-sm text-red-400" role="alert">
            <TriangleAlert className="size-4 shrink-0" />
            {formError}
          </p>
        )}

        {job && <ScrapeProgress job={job} />}
      </div>
    </section>
  );
}

/** Dropdown dos filtros: rótulo pequeno em cima e destaque vermelho quando fora do padrão. */
function FilterSelect({ label, icon: Icon, value, onChange, options, active }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">{label}</span>
      <span className="relative block">
        <Icon className={`pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 ${active ? 'text-red-500' : 'text-neutral-500'}`} />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${fieldClass} h-10 cursor-pointer appearance-none truncate pr-9 pl-9 font-medium ${
            active ? 'border-red-900/70 bg-red-950/20 text-white' : 'text-neutral-300'
          }`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <SelectChevron />
      </span>
    </label>
  );
}

function FiltersBar({ filters, onChange, onClear, onRefresh, isLoading, searches }) {
  const activeCount =
    Number(Boolean(filters.nicho)) +
    Number(Boolean(filters.grupo)) +
    Number(filters.contato !== 'todos') +
    Number(filters.visibilidade !== 'ativos') +
    Number(Boolean(filters.busca));

  const searchOptions = [
    { value: '', label: 'Todas as pesquisas' },
    ...(searches ?? []).map((s) => ({ value: s.term, label: `${s.term} (${s.visible})` })),
  ];
  // Se a pesquisa selecionada já não estiver na lista (ex.: todos ocultos), mantém-na visível.
  if (filters.busca && !searchOptions.some((o) => o.value === filters.busca)) {
    searchOptions.push({ value: filters.busca, label: filters.busca });
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-[#1a1a1a] p-3 sm:p-4" aria-label="Filtros de leads">
      <div className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Buscar por nicho</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            value={filters.nicho}
            onChange={(e) => onChange({ nicho: e.target.value })}
            placeholder="Filtrar por nicho (ex: Pizzaria, Mecânica)"
            className={`${fieldClass} pr-4 pl-10`}
          />
        </label>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          title="Recarregar leads"
          aria-label="Recarregar leads"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-neutral-800 text-neutral-400 transition hover:border-neutral-700 hover:bg-neutral-800 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.4fr_auto] xl:items-end">
        <FilterSelect label="Site" icon={SlidersHorizontal} value={filters.grupo} onChange={(grupo) => onChange({ grupo })} options={GROUP_OPTIONS} active={Boolean(filters.grupo)} />
        <FilterSelect label="Contato" icon={PhoneCall} value={filters.contato} onChange={(contato) => onChange({ contato })} options={CONTACT_OPTIONS} active={filters.contato !== 'todos'} />
        <FilterSelect label="Visibilidade" icon={EyeOff} value={filters.visibilidade} onChange={(visibilidade) => onChange({ visibilidade })} options={VISIBILITY_OPTIONS} active={filters.visibilidade !== 'ativos'} />
        <FilterSelect label="Pesquisa" icon={History} value={filters.busca} onChange={(busca) => onChange({ busca })} options={searchOptions} active={Boolean(filters.busca)} />
        <button
          type="button"
          onClick={onClear}
          disabled={!activeCount}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium whitespace-nowrap text-neutral-400 transition hover:bg-neutral-800 hover:text-white disabled:pointer-events-none disabled:opacity-40 sm:col-span-2 xl:col-span-1"
        >
          <X className="size-4" />
          Limpar filtros
          {activeCount > 0 && <span className="rounded-md bg-red-900/60 px-1.5 text-xs text-red-100 tabular-nums">{activeCount}</span>}
        </button>
      </div>
    </section>
  );
}

function GroupBadge({ group }) {
  if (group === 'SEM_SITE') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-linear-to-r from-red-700 to-red-600 px-2.5 py-1 text-[11px] font-bold tracking-wide text-white shadow-md shadow-red-900/50 ring-1 ring-red-500/40">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        SEM SITE
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold tracking-wide text-emerald-400 ring-1 ring-emerald-500/30">
      <Globe className="size-3" />
      COM SITE
    </span>
  );
}

function Rating({ rating, reviewsCount }) {
  if (!rating) {
    return <p className="text-sm text-neutral-500">Sem avaliações</p>;
  }

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Star className="size-4 fill-amber-400 text-amber-400" />
      <span className="font-semibold text-white">{ratingFormat.format(rating)}</span>
      {reviewsCount != null && (
        <span className="text-neutral-500">({numberFormat.format(reviewsCount)} avaliações)</span>
      )}
    </div>
  );
}

// Visual de cada etapa do funil. NOVO não tem badge: é o estado "limpo" do card.
const STATUS_META = {
  CONTATADO: { label: 'Abordado', icon: CheckCheck, className: 'bg-neutral-800 text-neutral-300 ring-neutral-700', iconClassName: 'text-emerald-400' },
  EM_NEGOCIACAO: { label: 'Em negociação', icon: Handshake, className: 'bg-amber-500/10 text-amber-300 ring-amber-500/30' },
  FECHADO: { label: 'Cliente', icon: Trophy, className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40' },
  DESCARTADO: { label: 'Descartado', icon: Ban, className: 'bg-neutral-800/60 text-neutral-500 ring-neutral-800' },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status];
  if (!meta) return null;
  const Icon = meta.icon;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${meta.className}`}
      title={`Status de prospecção: ${meta.label}`}
    >
      <Icon className={`size-3 ${meta.iconClassName ?? ''}`} />
      {meta.label}
    </span>
  );
}

/**
 * Interruptor "Contatado / Não contatado". Só alterna entre NOVO e CONTATADO; estados mais
 * avançados (negociação, cliente, descartado) aparecem como badge e são geridos no CRM.
 */
function ContactToggle({ lead, onToggle }) {
  if (!TOGGLEABLE_CONTACT.has(lead.status_prospeccao)) return <StatusBadge status={lead.status_prospeccao} />;
  const contacted = lead.status_prospeccao === 'CONTATADO';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={contacted}
      onClick={() => onToggle(lead)}
      title={contacted ? 'Marcar como não contatado' : 'Marcar como já contatado'}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${
        contacted
          ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/20'
          : 'bg-transparent text-neutral-400 ring-neutral-700 hover:bg-neutral-800 hover:text-white'
      }`}
    >
      {contacted ? <CheckCheck className="size-3.5" /> : <Circle className="size-3.5" />}
      {contacted ? 'Contatado' : 'Não contatado'}
    </button>
  );
}

function LeadCard({ lead, onContact, onToggleContact, onToggleHidden, onQualify, qualifying }) {
  const whatsappLink = gerarLinkWhatsApp(lead);
  const hasSite = lead.lead_group === 'COM_SITE' && lead.website;
  const alreadyApproached = lead.status_prospeccao && lead.status_prospeccao !== 'NOVO';
  const hidden = Boolean(lead.is_hidden);
  // Qualificar = mandar para a coluna "Triagem/Novo" do pipeline (só antes da negociação).
  const canQualify = !hidden && TOGGLEABLE_CONTACT.has(lead.status_prospeccao);

  // Clique (inclusive botão do meio / Ctrl+clique) abre o WhatsApp e registra a abordagem.
  const handleContact = (event) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    onContact(lead);
  };

  return (
    <article
      aria-label={lead.name}
      className={`group flex flex-col rounded-2xl border bg-[#1a1a1a] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-red-900/70 hover:shadow-xl hover:shadow-red-950/30 ${
        hidden ? 'border-dashed border-neutral-700 opacity-75 hover:opacity-100' : alreadyApproached ? 'border-neutral-800/60 opacity-80 hover:opacity-100' : 'border-neutral-800'
      }`}
    >
      {hidden && (
        <p className="-mt-1 mb-3 flex items-center gap-1.5 text-xs text-neutral-500">
          <EyeOff className="size-3.5" />
          Oculto {formatRelative(lead.hidden_at)}
        </p>
      )}
      <div className="flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-base leading-snug font-semibold text-white" title={lead.name}>
          {lead.name}
        </h3>
        <GroupBadge group={lead.lead_group} />
      </div>

      <div className="mt-3 space-y-2">
        {lead.category && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-300">
            <Tag className="size-3 text-red-500" />
            {lead.category}
          </span>
        )}
        <p className="flex items-start gap-1.5 text-sm text-neutral-400" title={lead.address || undefined}>
          <MapPin className="mt-0.5 size-4 shrink-0 text-neutral-600" />
          <span className="line-clamp-2">{shortAddress(lead.address)}</span>
        </p>
      </div>

      <div className="mt-3 mb-4 flex flex-wrap items-center justify-between gap-2">
        <Rating rating={lead.rating} reviewsCount={lead.reviews_count} />
        <ContactToggle lead={lead} onToggle={onToggleContact} />
      </div>

      <div className="mt-auto space-y-2 border-t border-neutral-800 pt-4">
        {whatsappLink ? (
          <a
            href={whatsappLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleContact}
            onAuxClick={handleContact}
            className={
              alreadyApproached
                ? 'flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 text-sm font-semibold whitespace-nowrap text-emerald-400 transition hover:bg-emerald-950/50 active:scale-[0.98]'
                : 'flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold whitespace-nowrap text-white shadow-md shadow-emerald-950/50 transition hover:bg-emerald-500 active:scale-[0.98]'
            }
          >
            <MessageCircle className="size-4" />
            {alreadyApproached ? 'Chamar novamente' : 'Chamar no WhatsApp'}
          </a>
        ) : (
          <span
            title={lead.phone ? `Número não compatível com WhatsApp: ${lead.phone}` : 'Telefone não informado'}
            className="flex h-10 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-neutral-800/70 px-4 text-sm font-medium text-neutral-500"
          >
            <PhoneOff className="size-4" />
            Sem WhatsApp
          </span>
        )}

        {canQualify && (
          <button
            type="button"
            onClick={() => onQualify(lead)}
            disabled={qualifying}
            title="Qualificar: cria o negócio na coluna Triagem/Novo do pipeline, com você como responsável"
            className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-red-900/60 bg-red-950/20 text-sm font-semibold text-red-200 transition hover:bg-red-950/50 hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            {qualifying ? <LoaderCircle className="size-4 animate-spin" /> : <Handshake className="size-4" />}
            {qualifying ? 'A qualificar...' : 'Qualificar para o CRM'}
          </button>
        )}

        <div className="flex gap-2">
          {hasSite && (
            <a
              href={lead.website}
              target="_blank"
              rel="noopener noreferrer"
              title={lead.website}
              className={secondaryButtonClass}
            >
              <Globe className="size-4" />
              Acessar Site
            </a>
          )}
          {lead.maps_url && (
            <a
              href={lead.maps_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Abrir no Google Maps"
              className={hasSite ? `${secondaryButtonClass} max-w-9 px-0` : secondaryButtonClass}
            >
              <MapPinned className="size-4 shrink-0" />
              {!hasSite && 'Ver no Maps'}
            </a>
          )}
          {!hidden && (
            <button
              type="button"
              onClick={() => onToggleHidden(lead)}
              title="Ocultar lead (arquivar)"
              aria-label={`Ocultar ${lead.name}`}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-neutral-600 transition hover:bg-neutral-800 hover:text-neutral-200 focus-visible:text-neutral-200"
            >
              <EyeOff className="size-4" />
            </button>
          )}
        </div>

        {/* Na vista de ocultos, restaurar é a ação principal: linha própria, largura total. */}
        {hidden && (
          <button
            type="button"
            onClick={() => onToggleHidden(lead)}
            title="Restaurar para a lista de leads ativos"
            className="flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-red-900/60 bg-red-950/20 text-sm font-semibold text-red-200 transition hover:bg-red-950/50 hover:text-white"
          >
            <ArchiveRestore className="size-4" />
            Restaurar lead
          </button>
        )}
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-neutral-800 bg-[#1a1a1a] p-5">
      <div className="flex justify-between gap-3">
        <div className="h-5 w-2/3 rounded bg-neutral-800" />
        <div className="h-5 w-16 rounded-full bg-neutral-800" />
      </div>
      <div className="mt-4 h-4 w-24 rounded bg-neutral-800/70" />
      <div className="mt-3 h-4 w-full rounded bg-neutral-800/70" />
      <div className="mt-2 h-4 w-3/4 rounded bg-neutral-800/70" />
      <div className="mt-6 space-y-2 border-t border-neutral-800 pt-4">
        <div className="h-10 rounded-xl bg-neutral-800" />
        <div className="h-9 rounded-xl bg-neutral-800/60" />
      </div>
    </div>
  );
}

function StateMessage({ icon: Icon, tone = 'neutral', title, description, action }) {
  const tones = {
    neutral: 'bg-neutral-800 text-neutral-400',
    red: 'bg-red-950/60 text-red-500 ring-1 ring-red-900/60',
  };

  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-800 bg-[#161616] px-6 py-16 text-center">
      <div className={`flex size-12 items-center justify-center rounded-full ${tones[tone]}`}>
        <Icon className="size-6" />
      </div>
      <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-neutral-400">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  const isSuccess = toast.type === 'success';
  const Icon = isSuccess ? CircleCheck : CircleX;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
    >
      <div
        className={`flex items-start gap-3 rounded-2xl border bg-[#1a1a1a]/95 p-4 shadow-2xl shadow-black/60 backdrop-blur ${
          isSuccess ? 'border-red-800/70' : 'border-red-600/70'
        }`}
      >
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
            isSuccess ? 'bg-red-800 text-white' : 'bg-red-950 text-red-400 ring-1 ring-red-800'
          }`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{toast.title}</p>
          {toast.message && <p className="mt-0.5 text-sm text-neutral-400">{toast.message}</p>}
          {toast.action && (
            <button
              type="button"
              onClick={toast.action.onClick}
              className="mt-2 rounded-lg border border-neutral-700 px-2.5 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:bg-neutral-800 hover:text-white"
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar alerta"
          className="-m-1 rounded-lg p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [reloadKey, setReloadKey] = useState(0);

  const [leads, setLeads] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ SEM_SITE: 0, COM_SITE: 0 });
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [toast, setToast] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [qualifyingIds, setQualifyingIds] = useState(() => new Set());
  const { user, isManager } = useAuth();
  const [, navigate] = useHashRoute('prospeccao');

  const debouncedNicho = useDebouncedValue(filters.nicho.trim());
  // Filtros efetivamente enviados à API (o nicho com debounce; os dropdowns aplicam na hora).
  const { grupo, contato, visibilidade, busca } = filters;
  const apiFilters = { nicho: debouncedNicho, grupo, contato, visibilidade, busca };
  const filtersKey = JSON.stringify(apiFilters);

  // Pesquisas já feitas no Radar (para o dropdown "Pesquisa").
  const { data: searches } = useQuery({ queryKey: ['leads', 'searches'], queryFn: fetchLeadSearches, staleTime: 60_000 });

  // Identifica a combinação de filtros ativa, para descartar respostas de "carregar mais" obsoletas.
  const queryKeyRef = useRef('');

  const refreshLeads = useCallback(() => setReloadKey((k) => k + 1), []);
  const changeFilters = useCallback((patch) => setFilters((current) => ({ ...current, ...patch })), []);

  const { job, start: startScrapeJob, isBusy: isScraping } = useScrapeJob({
    onFinish: (finishedJob, errorMessage) => {
      refreshLeads();
      queryClient.invalidateQueries({ queryKey: ['leads', 'searches'] });

      if (!finishedJob) {
        setToast({ type: 'error', title: 'Acompanhamento da busca interrompido', message: errorMessage });
      } else if (finishedJob.status === 'DONE') {
        setToast({
          type: 'success',
          title: 'Busca finalizada!',
          message: `“${finishedJob.search_term}”: ${numberFormat.format(finishedJob.found)} empresas encontradas, ${numberFormat.format(finishedJob.inserted)} novas e ${numberFormat.format(finishedJob.updated)} atualizadas.`,
          action: { label: 'Ver só esta pesquisa', onClick: () => { changeFilters({ ...DEFAULT_FILTERS, busca: finishedJob.search_term }); setToast(null); } },
        });
      } else {
        setToast({
          type: 'error',
          title: 'A varredura falhou',
          message: finishedJob.error || 'Erro desconhecido no scraper.',
        });
      }
    },
  });

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const current = JSON.parse(filtersKey);
    queryKeyRef.current = `${filtersKey}|${reloadKey}`;

    setStatus('loading');
    setError(null);

    Promise.all([
      fetchLeads({ ...current, limit: PAGE_SIZE, offset: 0, signal }),
      // Contadores do header (respeitam todos os filtros, exceto o próprio "site").
      fetchLeads({ ...current, grupo: 'SEM_SITE', limit: 1, offset: 0, signal }),
      fetchLeads({ ...current, grupo: 'COM_SITE', limit: 1, offset: 0, signal }),
    ])
      .then(([page, semSite, comSite]) => {
        setLeads(page.data);
        setTotal(page.total);
        setCounts({ SEM_SITE: semSite.total, COM_SITE: comSite.total });
        setStatus('success');
      })
      .catch((err) => {
        if (err.name === 'AbortError' || err.status === 401) return;
        setError(err.message);
        setStatus('error');
      });

    return () => controller.abort();
  }, [filtersKey, reloadKey]);

  const loadMore = useCallback(async () => {
    const requestKey = queryKeyRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchLeads({ ...JSON.parse(filtersKey), limit: PAGE_SIZE, offset: leads.length });
      if (queryKeyRef.current !== requestKey) return;
      setLeads((current) => [...current, ...page.data]);
      setTotal(page.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }, [filtersKey, leads.length]);

  /** O lead (já alterado) ainda pertence à vista com os filtros atuais? */
  const belongsToView = (lead) => {
    if (Boolean(lead.is_hidden) !== (visibilidade === 'ocultos')) return false;
    if (contato === 'contatados' && lead.status_prospeccao === 'NOVO') return false;
    if (contato === 'nao_contatados' && lead.status_prospeccao !== 'NOVO') return false;
    return true;
  };

  /**
   * Aplica uma alteração localmente (otimista). Se o lead deixar de corresponder aos filtros
   * (ex.: ocultado em "Leads ativos", contatado em "Não contatados"), sai da lista e os
   * contadores descem.
   */
  const applyLeadChange = (lead, changes) => {
    if (belongsToView({ ...lead, ...changes })) {
      setLeads((current) => current.map((l) => (l.id === lead.id ? { ...l, ...changes } : l)));
      return;
    }
    setLeads((current) => current.filter((l) => l.id !== lead.id));
    setTotal((t) => Math.max(0, t - 1));
    setCounts((c) => ({ ...c, [lead.lead_group]: Math.max(0, (c[lead.lead_group] ?? 0) - 1) }));
  };

  const handleStatusError = (lead, err, fallbackMessage) => {
    if (err.status === 401) return; // sessão expirou: o App já redireciona para o login
    refreshLeads(); // volta ao estado real do servidor
    if (err.status === 409 && err.body?.lead) {
      setToast({
        type: 'error',
        title: 'Atenção: lead já trabalhado',
        message: `"${lead.name}" já está com status ${err.body.lead.status_prospeccao} por outra pessoa da equipe.`,
      });
      return;
    }
    setToast({ type: 'error', title: 'Status não atualizado', message: `${fallbackMessage} ${err.message}` });
  };

  /**
   * Disparado ao clicar no WhatsApp: marca como CONTATADO sem bloquear a abertura do chat.
   * Troca condicional no backend (statusAtual: NOVO): não sobrescreve um lead que outro
   * vendedor já tenha avançado no funil.
   */
  const markAsContacted = async (lead) => {
    if (lead.status_prospeccao !== 'NOVO') return;
    applyLeadChange(lead, { status_prospeccao: 'CONTATADO' });
    try {
      await updateLeadStatus(lead.id, 'CONTATADO', { statusAtual: 'NOVO' });
    } catch (err) {
      handleStatusError(lead, err, `Não foi possível marcar "${lead.name}" como contatado.`);
    }
  };

  /** Interruptor manual "Contatado / Não contatado" (só entre NOVO e CONTATADO). */
  const toggleContact = async (lead) => {
    if (!TOGGLEABLE_CONTACT.has(lead.status_prospeccao)) return;
    const next = lead.status_prospeccao === 'NOVO' ? 'CONTATADO' : 'NOVO';
    applyLeadChange(lead, { status_prospeccao: next });
    try {
      await updateLeadStatus(lead.id, next, { statusAtual: lead.status_prospeccao });
    } catch (err) {
      handleStatusError(lead, err, `Não foi possível atualizar "${lead.name}".`);
    }
  };

  /** Ocultar (arquivar) ou restaurar — soft delete com "Desfazer". */
  const toggleHidden = async (lead) => {
    const hide = !lead.is_hidden;
    applyLeadChange(lead, { is_hidden: hide, hidden_at: hide ? new Date().toISOString() : null });
    try {
      await setLeadHidden(lead.id, hide);
      queryClient.invalidateQueries({ queryKey: ['leads', 'searches'] });
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      setToast({
        type: 'success',
        title: hide ? 'Lead ocultado' : 'Lead restaurado',
        message: hide ? `"${lead.name}" foi arquivado. Veja-o em Visibilidade › Ocultos.` : `"${lead.name}" voltou aos leads ativos.`,
        action: {
          label: 'Desfazer',
          onClick: async () => {
            setToast(null);
            try {
              await setLeadHidden(lead.id, !hide);
            } finally {
              refreshLeads();
              queryClient.invalidateQueries({ queryKey: ['leads', 'searches'] });
            }
          },
        },
      });
    } catch (err) {
      if (err.status === 401) return;
      refreshLeads();
      setToast({ type: 'error', title: hide ? 'Não foi possível ocultar' : 'Não foi possível restaurar', message: err.message });
    }
  };

  /**
   * Qualificar: o backend cria o negócio em "Triagem/Novo" (responsável = quem clicou), marca o
   * lead como EM_NEGOCIACAO e fecha a triagem. Não é otimista: só muda o card após confirmar.
   */
  const qualify = async (lead) => {
    setQualifyingIds((ids) => new Set(ids).add(lead.id));
    try {
      const { deal } = await qualifyLead(lead.id, { ownerId: isManager ? user?.id : undefined });
      applyLeadChange(lead, { status_prospeccao: 'EM_NEGOCIACAO' });
      queryClient.invalidateQueries({ queryKey: ['deals'] });
      queryClient.invalidateQueries({ queryKey: ['triage'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      setToast({
        type: 'success',
        title: 'Lead qualificado',
        message: `"${lead.name}" entrou na coluna Triagem/Novo do pipeline${deal?.owner_name ? `, com ${deal.owner_name} como responsável` : ''}.`,
        action: { label: 'Abrir pipeline', onClick: () => { setToast(null); navigate('pipeline'); } },
      });
    } catch (err) {
      if (err.status === 401) return;
      refreshLeads();
      setToast({
        type: 'error',
        title: err.status === 409 ? 'Lead já qualificado' : 'Não foi possível qualificar',
        message: err.message,
      });
    } finally {
      setQualifyingIds((ids) => {
        const next = new Set(ids);
        next.delete(lead.id);
        return next;
      });
    }
  };

  /** Exporta TODOS os leads dos filtros ativos (não só a página carregada na tela). */
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const current = JSON.parse(filtersKey);
      const rows = leads.length >= total ? leads : await fetchAllLeads(current);
      if (!rows.length) {
        setToast({ type: 'error', title: 'Nada para exportar', message: 'Nenhum lead corresponde aos filtros atuais.' });
        return;
      }
      exportLeadsCsv(rows, current);
      setToast({
        type: 'success',
        title: 'CSV exportado!',
        message: `${numberFormat.format(rows.length)} leads exportados. Pronto para subir como Público Personalizado no Meta Ads.`,
      });
    } catch (err) {
      if (err.status !== 401) setToast({ type: 'error', title: 'Falha na exportação', message: err.message });
    } finally {
      setExporting(false);
    }
  }, [filtersKey, leads, total]);

  const isLoading = status === 'loading';
  const hasMore = status === 'success' && leads.length < total;
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  let emptyTitle = 'Nenhum lead encontrado';
  let emptyDescription = 'O banco ainda está vazio. Use o Radar de Busca acima para iniciar a primeira varredura.';
  if (visibilidade === 'ocultos') {
    emptyTitle = 'Nenhum lead oculto';
    emptyDescription = 'Leads que ocultar (ícone do olho riscado no card) ficam aqui e podem ser restaurados a qualquer momento.';
  } else if (filtered) {
    emptyDescription = 'Nenhuma empresa corresponde aos filtros atuais. Ajuste os filtros ou limpe-os.';
  }

  return (
    <div>
      <Header
        loaded={leads.length}
        total={total}
        counts={counts}
        isLoading={isLoading}
        onExport={handleExport}
        exporting={exporting}
      />

      <div className="mt-6 space-y-6">
        <RadarSearch job={job} isBusy={isScraping} onStart={startScrapeJob} />

        <FiltersBar
          filters={filters}
          onChange={changeFilters}
          onClear={() => setFilters(DEFAULT_FILTERS)}
          onRefresh={refreshLeads}
          isLoading={isLoading}
          searches={searches}
        />

        {status === 'error' && (
          <StateMessage
            icon={TriangleAlert}
            tone="red"
            title="Erro ao carregar os leads"
            description={error}
            action={
              <button
                type="button"
                onClick={refreshLeads}
                className="inline-flex items-center gap-2 rounded-xl bg-red-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700"
              >
                <RefreshCw className="size-4" />
                Tentar novamente
              </button>
            }
          />
        )}

        {isLoading && leads.length === 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {status === 'success' && leads.length === 0 && (
          <StateMessage
            icon={visibilidade === 'ocultos' ? EyeOff : SearchX}
            title={emptyTitle}
            description={emptyDescription}
            action={
              filtered && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  className="inline-flex items-center gap-2 rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800"
                >
                  <X className="size-4" />
                  Limpar filtros
                </button>
              )
            }
          />
        )}

        {leads.length > 0 && status !== 'error' && (
          <div
            className={`grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${
              isLoading ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            {leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onContact={markAsContacted}
                onToggleContact={toggleContact}
                onToggleHidden={toggleHidden}
                onQualify={qualify}
                qualifying={qualifyingIds.has(lead.id)}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 rounded-xl border border-neutral-800 bg-[#1a1a1a] px-5 py-2.5 text-sm font-semibold text-neutral-300 transition hover:border-red-900/70 hover:text-white disabled:opacity-60"
            >
              {loadingMore && <LoaderCircle className="size-4 animate-spin text-red-500" />}
              Carregar mais ({numberFormat.format(total - leads.length)} restantes)
            </button>
          </div>
        )}
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
