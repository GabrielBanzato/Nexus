import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarClock, CheckCircle2, Package, Repeat, UserRound, Wallet } from 'lucide-react';
import { ackAlert, getPendingAlerts } from '../lib/api.js';
import { formatCurrency } from '../lib/labels.js';
import { useSocketEvent } from '../lib/socket.js';
import { useToast } from './toast.jsx';
import { Button } from './ui.jsx';

const QUERY_KEY = ['alerts', 'pending'];
const VIBRATE = [800, 250, 800, 250, 800];
const dateBr = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '—');
const monthBr = (ymd) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '');

/** Bip curto repetido (Web Audio; o navegador só toca depois de um toque na página). */
function useAlarmSound(active) {
  useEffect(() => {
    if (!active) return undefined;
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return undefined;
    }
    const beep = () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t = ctx.currentTime;
      for (const [offset, freq] of [[0, 880], [0.18, 1175], [0.36, 1568]]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + offset);
        osc.stop(t + offset + 0.17);
      }
    };
    beep();
    const timer = setInterval(beep, 3000);
    return () => {
      clearInterval(timer);
      ctx.close().catch(() => {});
    };
  }, [active]);
}

/** Vibração em ciclo até confirmar (Android; o iPhone não deixa a página vibrar). */
function useVibrationLoop(active) {
  useEffect(() => {
    if (!active || !navigator.vibrate) return undefined;
    const buzz = () => navigator.vibrate(VIBRATE);
    buzz();
    const timer = setInterval(buzz, 4000);
    return () => {
      clearInterval(timer);
      navigator.vibrate(0);
    };
  }, [active]);
}

function Row({ icon: Icon, label, children }) {
  return (
    <div className="flex gap-3 rounded-xl bg-black/30 px-3 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-emerald-300" />
      <div className="min-w-0">
        <p className="text-xs text-emerald-200/60">{label}</p>
        <p className="text-sm font-medium whitespace-pre-line text-white">{children}</p>
      </div>
    </div>
  );
}

/** Ecrã inteiro: cliente fechado, a tocar e a vibrar até o admin confirmar. */
function WonAlarm({ alert, remaining, onAck, acking }) {
  const d = alert.details;
  const buttonRef = useRef(null);
  useEffect(() => buttonRef.current?.focus(), [alert.id]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="alarm-title">
      <div className="w-full max-w-md animate-[alarm-pop_.35s_ease-out] overflow-hidden rounded-3xl border border-emerald-700/60 bg-linear-to-b from-emerald-950 to-[#0f1a14] shadow-2xl shadow-emerald-950/60">
        <div className="relative px-6 pt-6 pb-4 text-center">
          <span className="relative mx-auto flex size-16 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/40" />
            <span className="relative flex size-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-900">
              <BellRing className="size-8" />
            </span>
          </span>
          <h2 id="alarm-title" className="mt-4 text-xl font-bold text-white">{alert.title}</h2>
          <p className="mt-1 text-sm text-emerald-100/70">{d.deal_title}{d.company && d.company !== d.deal_title ? ` · ${d.company}` : ''}</p>
        </div>
        <div className="space-y-2 px-5">
          <Row icon={Package} label="Sistema a fazer">{d.won_scope}</Row>
          <div className="grid grid-cols-2 gap-2">
            <Row icon={Wallet} label="Valor negociado">{formatCurrency(d.value)}</Row>
            <Row icon={CalendarClock} label="Prazo">{dateBr(d.delivery_due)}</Row>
          </div>
          {d.monthly_value > 0 && <Row icon={Repeat} label="Mensalidade">{`${formatCurrency(d.monthly_value)}/mês desde ${monthBr(d.monthly_start)}`}</Row>}
          {d.owner_name && <Row icon={UserRound} label="Vendedor">{d.owner_name}</Row>}
        </div>
        <div className="p-5">
          <Button ref={buttonRef} icon={CheckCircle2} loading={acking} onClick={onAck} className="h-12 w-full !bg-emerald-600 text-base hover:!bg-emerald-500">
            Recebi e vi
          </Button>
          {remaining > 0 && <p className="mt-2 text-center text-xs text-emerald-100/60">Mais {remaining} {remaining === 1 ? 'fecho' : 'fechos'} por confirmar</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Admin: avisos do pipeline em qualquer página.
 *  - Cliente fechado: alarme no ecrã (som + vibração) até "Recebi e vi"; no telemóvel a
 *    notificação repete-se (servidor) até confirmar aqui ou no botão da notificação.
 *  - Negócio perdido: aviso com o motivo.
 */
export default function AdminAlarm({ enabled }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [ackError, setAckError] = useState(null);
  const { data: pending = [] } = useQuery({ queryKey: QUERY_KEY, queryFn: getPendingAlerts, enabled, refetchInterval: 60_000 });

  const drop = (id) => queryClient.setQueryData(QUERY_KEY, (list = []) => list.filter((a) => a.id !== id));

  useSocketEvent('alert:new', (alert) => {
    if (!enabled) return;
    if (alert.needs_ack) {
      queryClient.setQueryData(QUERY_KEY, (list = []) => (list.some((a) => a.id === alert.id) ? list : [...list, alert]));
    } else {
      navigator.vibrate?.([300, 150, 300]);
      toast.error(alert.title, alert.body, { duration: 30_000, action: { label: 'Ver no pipeline', onClick: () => { window.location.hash = '/pipeline'; } } });
    }
    queryClient.invalidateQueries({ queryKey: ['deals'] });
  });
  useSocketEvent('alert:acked', ({ id }) => drop(id));

  const current = enabled ? pending[0] : null;
  useAlarmSound(Boolean(current));
  useVibrationLoop(Boolean(current));

  const ack = useMutation({
    mutationFn: (id) => ackAlert(id),
    onSuccess: (_, id) => {
      setAckError(null);
      drop(id);
    },
    onError: (err) => setAckError(err.message),
  });

  if (!current) return null;
  return (
    <>
      <WonAlarm alert={current} remaining={pending.length - 1} acking={ack.isPending} onAck={() => ack.mutate(current.id)} />
      {ackError && <p className="fixed bottom-4 left-1/2 z-[71] -translate-x-1/2 rounded-xl bg-red-950 px-4 py-2 text-sm text-red-200">{ackError}</p>}
    </>
  );
}
