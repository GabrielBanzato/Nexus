import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, SpellCheck, Wand2 } from 'lucide-react';
import { reviewWithNex } from '../lib/api.js';
import { cx } from './ui.jsx';

/**
 * Nex: a IA da casa revê TODAS as mensagens antes de saírem pela Central (sempre ligado).
 * Enquanto o consultor escreve, a cada pausa o Nex devolve a correção ortográfica e uma
 * reformulação, no idioma do próprio texto. O botão de enviar só fica liberado quando o pop-up
 * do Nex para aquele texto exato aparece (ou quando o Nex não responde: aí avisa e libera).
 */

const IDLE_MS = 1200; // pausa a escrever antes de pedir a revisão

/**
 * @returns {{ review: null | { text, status: 'loading'|'ready'|'error', corrected?, rewrite?, error? },
 *             ready: boolean, reviewNow: () => void, accept: (text: string) => void, reset: () => void }}
 *   ready = há um pop-up (resultado ou erro) para o texto ATUAL: pode enviar.
 */
export function useNexReview(text) {
  const trimmed = text.trim();
  const [review, setReview] = useState(null);
  const controller = useRef(null);
  const timer = useRef(null);

  const start = (value) => {
    clearTimeout(timer.current);
    controller.current?.abort();
    if (!value) return setReview(null);
    const ac = new AbortController();
    controller.current = ac;
    setReview({ text: value, status: 'loading' });
    reviewWithNex(value, { signal: ac.signal })
      .then((data) => {
        if (!ac.signal.aborted) setReview({ text: value, status: 'ready', corrected: data.corrected, rewrite: data.rewrite });
      })
      .catch((err) => {
        if (ac.signal.aborted || err.name === 'AbortError') return;
        setReview({ text: value, status: 'error', error: err.message, code: err.body?.code });
      });
  };

  // Revisão automática a cada pausa (o texto mudou desde a última revisão).
  useEffect(() => {
    clearTimeout(timer.current);
    if (!trimmed) {
      controller.current?.abort();
      setReview(null);
      return undefined;
    }
    if (review?.text === trimmed) return undefined; // já revisto (ou a rever) este texto exato
    timer.current = setTimeout(() => start(trimmed), IDLE_MS);
    return () => clearTimeout(timer.current);
  }, [trimmed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    clearTimeout(timer.current);
    controller.current?.abort();
  }, []);

  const ready = Boolean(review && review.text === trimmed && review.status !== 'loading');
  return {
    review,
    ready,
    /** Enter/enviar antes da pausa: pede já (se ainda não estiver a rever este texto). */
    reviewNow: () => {
      if (!trimmed || (review?.text === trimmed && review.status === 'loading')) return;
      start(trimmed);
    },
    /** O consultor escolheu a versão do Nex: esse texto já está revisto, pode enviar logo. */
    accept: (value) => setReview((prev) => (prev ? { ...prev, text: value.trim() } : prev)),
    reset: () => {
      clearTimeout(timer.current);
      controller.current?.abort();
      setReview(null);
    },
  };
}

// --- diferenças palavra a palavra (para destacar o que o Nex corrigiu) ---------------------

const tokens = (s) => s.match(/\s+|[^\s]+/g) ?? [];

/** Marca, no texto corrigido, as palavras que não existiam no original (LCS por palavra). */
function diffWords(original, corrected) {
  const a = tokens(original);
  const b = tokens(corrected);
  if (a.length * b.length > 400_000) return [{ text: corrected, changed: false }];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      out.push({ text: b[j], changed: false });
      i += 1;
      j += 1;
    } else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      out.push({ text: b[j], changed: /\S/.test(b[j]) });
      j += 1;
    }
  }
  return out;
}

function Option({ icon: Icon, title, children, onUse, label, tone }) {
  return (
    <div className={cx('rounded-lg p-2 ring-1', tone === 'emerald' ? 'bg-emerald-950/30 ring-emerald-900/60' : 'bg-violet-950/30 ring-violet-900/60')}>
      <div className={cx('mb-1 flex items-center gap-1.5 text-[11px] font-semibold', tone === 'emerald' ? 'text-emerald-300' : 'text-violet-300')}>
        <Icon className="size-3" />
        {title}
        {onUse && (
          <button
            type="button"
            onClick={onUse}
            className={cx('ml-auto rounded-md px-2 py-0.5 text-[11px] font-semibold text-white transition', tone === 'emerald' ? 'bg-emerald-700/80 hover:bg-emerald-600' : 'bg-violet-700/80 hover:bg-violet-600')}
          >
            {label}
          </button>
        )}
      </div>
      <p className="max-h-28 overflow-y-auto text-sm break-words whitespace-pre-wrap text-neutral-100">{children}</p>
    </div>
  );
}

/** Pop-up do Nex, logo acima da caixa de texto. */
export function NexReviewCard({ nex, text, onUse }) {
  const { review } = nex;
  if (!text.trim() || !review) return null;
  const current = review.text === text.trim();

  if (review.status === 'loading' || !current) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-violet-950/30 px-3 py-2 text-xs text-violet-200 ring-1 ring-violet-900/60" role="status">
        <LoaderCircle className="size-3.5 animate-spin" />
        <span><strong className="font-semibold">Nex</strong> está a rever a ortografia e a preparar uma sugestão... o envio libera quando terminar.</span>
      </div>
    );
  }

  if (review.status === 'error') {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-amber-950/30 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-900/60" role="status">
        <CircleAlert className="size-3.5 shrink-0" />
        <span>
          <strong className="font-semibold">Nex</strong> {review.code === 'NEX_DISABLED' ? 'está desligado neste servidor' : 'não respondeu agora'}: pode enviar o seu texto como está.
        </span>
      </div>
    );
  }

  const clean = review.corrected.trim() === review.text;
  const sameRewrite = review.rewrite.trim() === review.corrected.trim();
  const parts = clean ? null : diffWords(review.text, review.corrected);
  return (
    <div className="mb-2 space-y-1.5 rounded-xl bg-[#17131f] p-2 ring-1 ring-violet-900/50" role="status" aria-live="polite">
      <p className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold text-violet-200">
        <Wand2 className="size-3" />
        Nex revisou a sua mensagem
      </p>
      {clean ? (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-950/30 px-2 py-1.5 text-xs text-emerald-200 ring-1 ring-emerald-900/60">
          <Check className="size-3.5" /> Ortografia certa: nada a corrigir.
        </p>
      ) : (
        <Option icon={SpellCheck} title="Correção" tone="emerald" label="Usar correção" onUse={() => onUse(review.corrected)}>
          {parts.map((p, i) => (p.changed ? <mark key={i} className="rounded bg-emerald-500/25 px-0.5 text-emerald-100">{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </Option>
      )}
      {!sameRewrite && (
        <Option icon={Wand2} title="Sugestão do Nex" tone="violet" label="Usar sugestão" onUse={() => onUse(review.rewrite)}>
          {review.rewrite}
        </Option>
      )}
    </div>
  );
}
