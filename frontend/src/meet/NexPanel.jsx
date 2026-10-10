import { useEffect, useRef, useState } from 'react';
import { BadgeDollarSign, Check, ChevronDown, CircleAlert, Copy, FileText, HelpCircle, Lightbulb, LoaderCircle, Pause, Play, RefreshCw, Save, ShieldAlert, Target, Wand2, X } from 'lucide-react';
import { createNexListener, nexListenerSupported } from './nexListener.js';

const cx = (...c) => c.filter(Boolean).join(' ');

const SECTIONS = [
  { key: 'pains', title: 'Dores', icon: Target, tone: 'text-rose-300', dot: 'bg-rose-400' },
  { key: 'questions', title: 'Dúvidas', icon: HelpCircle, tone: 'text-sky-300', dot: 'bg-sky-400' },
  { key: 'objections', title: 'Objeções e receios', icon: ShieldAlert, tone: 'text-amber-300', dot: 'bg-amber-400' },
  { key: 'signals', title: 'Sinais de compra', icon: BadgeDollarSign, tone: 'text-emerald-300', dot: 'bg-emerald-400' },
];

function useCopy() {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) =>
      navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }),
  ];
}

function Proposal({ proposal, onClose }) {
  const [copied, copy] = useCopy();
  const text = [proposal.summary, proposal.proposal, ...(proposal.arguments ?? []).map((a) => `• ${a}`), proposal.closing].filter(Boolean).join('\n\n');
  return (
    <div className="rounded-xl bg-violet-950/40 p-3 ring-1 ring-violet-800/60">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-violet-200">
        <FileText className="size-3.5" /> Proposta sugerida
        <button type="button" onClick={() => copy(text)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-900/60 hover:text-white">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? 'Copiado' : 'Copiar'}
        </button>
        <button type="button" onClick={onClose} aria-label="Fechar proposta" className="rounded p-0.5 text-violet-400 hover:text-white">
          <X className="size-3.5" />
        </button>
      </div>
      {proposal.summary && <p className="text-xs text-violet-200/80 italic">{proposal.summary}</p>}
      <p className="mt-2 text-sm whitespace-pre-wrap text-violet-50">{proposal.proposal}</p>
      {proposal.arguments?.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-violet-100">
          {proposal.arguments.map((a, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-violet-300" />
              {a}
            </li>
          ))}
        </ul>
      )}
      {proposal.closing && <p className="mt-2 rounded-lg bg-violet-900/40 px-2 py-1.5 text-xs font-medium text-white">“{proposal.closing}”</p>}
    </div>
  );
}

/**
 * Coluna do Nex na reunião (só equipe): ouve cada participante (nexListener → Whisper local),
 * mostra a transcrição e os pontos da negociação (dores, dúvidas, objeções, sinais), uma dica
 * para o momento e, a pedido, uma proposta montada com o que se ouviu.
 */
export default function NexPanel({ call, localStream, peers, className, onClose }) {
  const { nex, socket, nexRequest, sendNexAudio, phase } = call;
  const [snapshot, setSnapshot] = useState(null);
  const [segments, setSegments] = useState([]);
  const [insights, setInsights] = useState({});
  const [analyzing, setAnalyzing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(null); // 'propose' | 'save' | 'analyze'
  const [notice, setNotice] = useState(null);
  const [showTranscript, setShowTranscript] = useState(true);
  const transcriptRef = useRef(null);
  const supported = nexListenerSupported();

  // Estado inicial (o que já foi dito/anotado, se reentrou) e eventos em tempo real.
  useEffect(() => {
    if (!socket || phase !== 'in-call' || !nex.available) return undefined;
    let alive = true;
    nexRequest('nex:snapshot').then((s) => {
      if (!alive || s.error) return;
      setSnapshot(s);
      setSegments(s.segments ?? []);
      setInsights(s.insights ?? {});
    });
    const onTranscript = (seg) => setSegments((all) => [...all.slice(-299), seg]);
    const onInsights = (data) => setInsights(data ?? {});
    const onStatus = (st) => {
      if ('analyzing' in st) setAnalyzing(st.analyzing);
      if ('paused' in st) setPaused(st.paused);
      if (st.transcription === 'error') setError('A transcrição falhou em um trecho (o serviço de voz pode estar iniciando).');
    };
    socket.on('nex:transcript', onTranscript);
    socket.on('nex:insights', onInsights);
    socket.on('nex:status', onStatus);
    return () => {
      alive = false;
      socket.off('nex:transcript', onTranscript);
      socket.off('nex:insights', onInsights);
      socket.off('nex:status', onStatus);
    };
  }, [socket, phase, nex.available, nexRequest]);

  // Ouvido: grava cada participante e manda os pedaços com fala.
  const sourcesRef = useRef([]);
  sourcesRef.current = [{ key: 'self', stream: localStream }, ...peers.map((p) => ({ key: p.id, stream: p.stream }))];
  useEffect(() => {
    if (!socket || phase !== 'in-call' || !nex.available || paused || !supported) return undefined;
    const listener = createNexListener({ getSources: () => sourcesRef.current, onChunk: sendNexAudio });
    listener.start();
    return () => {
      listener.stop();
    };
  }, [socket, phase, nex.available, paused, supported, sendNexAudio]);

  // Transcrição sempre no fim (a não ser que esteja a ler mais acima).
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [segments, showTranscript]);

  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    await nexRequest('nex:pause', { paused: next });
  };

  const run = async (kind, event, onResult) => {
    setBusy(kind);
    setNotice(null);
    const result = await nexRequest(event);
    setBusy(null);
    if (result.error) setNotice({ tone: 'error', text: result.error });
    else onResult?.(result);
  };

  const status = !nex.available
    ? { label: 'Desligado', tone: 'bg-neutral-800 text-neutral-400' }
    : !supported
      ? { label: 'Navegador sem suporte', tone: 'bg-amber-950/60 text-amber-300' }
      : paused
        ? { label: 'Pausado', tone: 'bg-neutral-800 text-neutral-300' }
        : analyzing
          ? { label: 'Analisando...', tone: 'bg-violet-950/70 text-violet-200' }
          : { label: 'Ouvindo', tone: 'bg-emerald-950/60 text-emerald-300', live: true };
  const total = SECTIONS.reduce((n, s) => n + (insights[s.key]?.length ?? 0), 0);

  return (
    <aside className={cx('flex min-h-0 flex-col border-l border-neutral-800/80 bg-[#121014]', className)} aria-label="Nex: assistente da reunião">
      <div className="flex items-center gap-2 border-b border-neutral-800/80 px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-linear-to-br from-violet-600 to-violet-950 ring-1 ring-violet-500/30">
          <Wand2 className="size-3.5 text-white" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">Nex</p>
          <p className="text-[11px] text-neutral-500">Só você vê esta coluna</p>
        </div>
        <span className={cx('ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', status.tone)}>
          {status.live && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />}
          {status.label}
        </span>
        {nex.available && supported && (
          <button type="button" onClick={togglePause} aria-label={paused ? 'Retomar o Nex' : 'Pausar o Nex'} title={paused ? 'Retomar' : 'Pausar (o cliente deixa de ver o aviso)'} className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white">
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Fechar o Nex" className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white lg:hidden">
            <X className="size-4" />
          </button>
        )}
      </div>

      {!nex.available ? (
        <p className="m-4 rounded-xl bg-neutral-900 p-3 text-sm text-neutral-400 ring-1 ring-neutral-800">
          A transcrição das reuniões está desligada neste servidor. Para ligar, suba o serviço <strong className="text-neutral-200">whisper</strong> do docker-compose.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {!supported && (
            <p className="rounded-xl bg-amber-950/40 p-3 text-xs text-amber-200 ring-1 ring-amber-900/50">Este navegador não consegue gravar o áudio para o Nex. Use o Chrome ou o Edge no computador.</p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 text-xs text-amber-300">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {error}
            </p>
          )}

          {insights.tip && (
            <div className="rounded-xl bg-violet-950/40 p-3 ring-1 ring-violet-800/50" role="status" aria-live="polite">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-violet-300 uppercase">
                <Lightbulb className="size-3.5" /> Dica para agora
              </p>
              <p className="text-sm text-violet-50">{insights.tip}</p>
            </div>
          )}

          {total === 0 && !insights.tip && (
            <p className="rounded-xl bg-neutral-900/70 p-3 text-xs text-neutral-400 ring-1 ring-neutral-800">
              {snapshot?.analysis === false
                ? 'A IA está desligada neste servidor: o Nex só transcreve.'
                : 'Conforme o cliente fala, o Nex anota aqui as dores, dúvidas, objeções e sinais de compra, e sugere o que dizer.'}
            </p>
          )}

          {SECTIONS.map(({ key, title, icon: Icon, tone, dot }) =>
            insights[key]?.length ? (
              <section key={key}>
                <h3 className={cx('mb-1 flex items-center gap-1.5 text-xs font-semibold', tone)}>
                  <Icon className="size-3.5" /> {title}
                  <span className="text-neutral-500">{insights[key].length}</span>
                </h3>
                <ul className="space-y-1">
                  {insights[key].map((text, i) => (
                    <li key={i} className="flex gap-2 rounded-lg bg-neutral-900/70 px-2.5 py-1.5 text-[13px] leading-snug text-neutral-100 ring-1 ring-neutral-800/80">
                      <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', dot)} />
                      {text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}

          {snapshot?.analysis !== false && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => run('propose', 'nex:propose', (r) => setProposal(r.proposal))}
                disabled={Boolean(busy) || segments.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'propose' ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
                {busy === 'propose' ? 'Montando...' : 'Sugerir proposta'}
              </button>
              <button
                type="button"
                onClick={() => run('analyze', 'nex:analyze')}
                disabled={Boolean(busy) || analyzing}
                title="Analisa já o que foi dito desde a última vez"
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-300 ring-1 ring-neutral-700 hover:bg-neutral-800 disabled:opacity-50"
              >
                <RefreshCw className={cx('size-3.5', analyzing && 'animate-spin')} /> Atualizar
              </button>
              {snapshot?.has_deal && total > 0 && (
                <button
                  type="button"
                  onClick={() => run('save', 'nex:save-deal', (r) => setNotice({ tone: 'ok', text: r.saved ? `${r.saved} ponto(s) salvo(s) nas dores do negócio.` : 'Tudo já estava salvo no negócio.' }))}
                  disabled={Boolean(busy)}
                  title="Junta as dores e os receios ao campo “dores” do negócio no pipeline"
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-300 ring-1 ring-neutral-700 hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy === 'save' ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Salvar no negócio
                </button>
              )}
            </div>
          )}
          {notice && <p className={cx('text-xs', notice.tone === 'error' ? 'text-amber-300' : 'text-emerald-300')}>{notice.text}</p>}
          {proposal && <Proposal proposal={proposal} onClose={() => setProposal(null)} />}

          <section className="rounded-xl ring-1 ring-neutral-800">
            <button type="button" onClick={() => setShowTranscript((v) => !v)} className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold text-neutral-300">
              Transcrição <span className="font-normal text-neutral-500">{segments.length ? `· ${segments.length} falas` : ''}</span>
              <ChevronDown className={cx('ml-auto size-3.5 transition', showTranscript && 'rotate-180')} />
            </button>
            {showTranscript && (
              <div ref={transcriptRef} className="max-h-72 space-y-1.5 overflow-y-auto border-t border-neutral-800 px-3 py-2">
                {segments.length === 0 ? (
                  <p className="text-xs text-neutral-500">{paused ? 'Nex pausado.' : 'Ouvindo... as falas aparecem aqui uns segundos depois.'}</p>
                ) : (
                  segments.map((s) => (
                    <p key={s.id} className="text-xs leading-relaxed">
                      <span className={cx('font-semibold', s.role === 'guest' ? 'text-sky-300' : 'text-red-300')}>{s.name}: </span>
                      <span className="text-neutral-300">{s.text}</span>
                    </p>
                  ))
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
